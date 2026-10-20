# The FUTO supporter coin, modelled once in Blender for all three shells.
#
# This script IS the coin. Desktop (three.js), iOS (RealityKit) and Android
# (Filament) all render the files it exports, so the object is authored in one
# place and the shells only frame, light and turn it.
#
#   blender --background --factory-startup --python assets/coin/build-coin.py
#
# Outputs, all into assets/coin/ next to this file:
#   futo-coin.glb    glTF 2.0 binary — desktop three.js and Android Filament
#   futo-coin.usdz   USD — iOS RealityKit
#   studio-env.hdr   equirectangular radiance map — the metal's reflections
#
# Every output records the sha256 of every .py in this folder (this file,
# studio_env.py, coin_export.py) so a change to any of them that was never
# regenerated fails `just coin-check` instead of shipping a stale coin.

import math
import os
import sys

import bpy
import bmesh
from mathutils import Vector

# Blender runs this file by path, so its siblings are not importable until their
# folder is on sys.path. No bytecode: assets/coin/ holds sources and exports only.
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from coin_export import script_digest, write_manifest
from studio_env import build_environment

HERE = os.path.dirname(os.path.abspath(bpy.data.filepath or __file__))
if "--" in sys.argv:
    HERE = sys.argv[sys.argv.index("--") + 1]
OUT = HERE


# ── The coin's dimensions ────────────────────────────────────────────────────
# Straight from src/features/license/supporterCoin.ts, which took them from
# lib-polar's coin-bounce.js. The storefront coin and this one are the same
# object, so these numbers are not free to drift.

OUTER_RADIUS = 0.35
DEPTH = OUTER_RADIUS / 6.0
DIAMOND_HALF = OUTER_RADIUS * 0.45
CORNER_RADIUS = min(OUTER_RADIUS * 0.16, DIAMOND_HALF * 0.7)

# How finely the outer circle and each rounded corner are sampled. 128 around
# the disc keeps the silhouette smooth at the 480px the coin can reach on a 3x
# phone screen; below about 96 the rim goes visibly faceted when it catches a
# highlight.
CIRCLE_SEGMENTS = 128
CORNER_SEGMENTS = 24

# The edge bevel. This is the one thing the old procedural three.js coin did
# not have (`bevelEnabled: false`) and the biggest single reason it read as CG:
# a perfectly sharp metal edge catches no highlight at all, so the disc's rim
# went dead flat. A bevel a tenth of the coin's thickness gives every edge a
# bright line that travels as the coin turns.
BEVEL_WIDTH = DEPTH * 0.10
BEVEL_SEGMENTS = 3

# sRGB hex from supporterCoin.ts. Blender wants linear.
FACE_SRGB = (0xFF, 0xBB, 0x00)
RIM_SRGB = (0xB8, 0x86, 0x0B)

FACE_ROUGHNESS = 0.22
RIM_ROUGHNESS = 0.30

# A face is a face and not a rim when its normal is within ~45 degrees of the
# coin's axis. The bevel ring lands on the rim side, which is what you want:
# the bright edge line belongs to the metal that turns, not to the flat.
FACE_NORMAL_Z = 0.72


def srgb_to_linear(channel: int) -> float:
    """One 0-255 sRGB channel as Blender's linear scene-referred float."""
    value = channel / 255.0
    if value <= 0.04045:
        return value / 12.92
    return ((value + 0.055) / 1.055) ** 2.4


def linear_rgba(srgb: tuple) -> tuple:
    return (*(srgb_to_linear(c) for c in srgb), 1.0)


# ── The flat profile ─────────────────────────────────────────────────────────


def circle_points(radius: float, segments: int) -> list:
    """The outer disc, counter-clockwise."""
    return [
        Vector((radius * math.cos(2 * math.pi * i / segments),
                radius * math.sin(2 * math.pi * i / segments)))
        for i in range(segments)
    ]


def towards(origin: Vector, target: Vector, distance: float) -> Vector:
    """`distance` along the line from `origin` to `target`."""
    return origin + (target - origin).normalized() * distance


def quadratic(start: Vector, control: Vector, end: Vector, segments: int) -> list:
    """A quadratic Bezier, sampled WITHOUT its first point.

    The caller already has the start point on its path, and repeating it would
    leave a zero-length edge that the bevel then cannot solve.
    """
    out = []
    for i in range(1, segments + 1):
        t = i / segments
        inverse = 1 - t
        out.append(
            start * (inverse * inverse)
            + control * (2 * inverse * t)
            + end * (t * t)
        )
    return out


def diamond_points() -> list:
    """The FUTO diamond: a square on its point with rounded corners.

    Ported corner for corner from `buildCoinGeometry` in supporterCoin.ts, so
    the hole in the model is the same hole the flat glyph punches. The glyph
    gate (scripts/check-supporter-coin-glyph.mjs) derives its SVG path from the
    same four numbers.
    """
    top = Vector((0.0, DIAMOND_HALF))
    left = Vector((-DIAMOND_HALF, 0.0))
    bottom = Vector((0.0, -DIAMOND_HALF))
    right = Vector((DIAMOND_HALF, 0.0))

    points = [towards(top, left, CORNER_RADIUS)]
    for corner, following in ((top, right), (right, bottom), (bottom, left), (left, top)):
        after = towards(corner, following, CORNER_RADIUS)
        points += quadratic(points[-1], corner, after, CORNER_SEGMENTS)
        points.append(towards(following, corner, CORNER_RADIUS))
    # The loop closes onto its own first point; bmesh adds that edge itself.
    points.pop()
    return points


def build_profile_mesh() -> bpy.types.Object:
    """The flat washer: the disc with the diamond cut out, as a triangulated face.

    A face cannot have a hole, so the two loops are bridged rather than filled:
    `bmesh.ops.triangle_fill` over both boundary loops at once produces the ring
    between them and nothing inside the diamond, which is exactly the washer.
    """
    mesh = bpy.data.meshes.new("futo_coin")
    bm = bmesh.new()

    outer = [bm.verts.new((p.x, p.y, 0.0)) for p in circle_points(OUTER_RADIUS, CIRCLE_SEGMENTS)]
    inner = [bm.verts.new((p.x, p.y, 0.0)) for p in diamond_points()]
    bm.verts.ensure_lookup_table()

    edges = []
    for loop in (outer, inner):
        for index, vert in enumerate(loop):
            edges.append(bm.edges.new((vert, loop[(index + 1) % len(loop)])))

    # `use_dissolve=False` keeps the triangles; we want real geometry here, not
    # an n-gon, because Solidify and Bevel both behave better on it.
    bmesh.ops.triangle_fill(bm, use_beauty=True, use_dissolve=False, edges=edges)

    # triangle_fill happily fills the diamond too when it decides the inner loop
    # is a separate island. Delete any face whose centre is inside the diamond.
    inside = [f for f in bm.faces if point_in_polygon(f.calc_center_median().xy, inner)]
    if inside:
        bmesh.ops.delete(bm, geom=inside, context="FACES")

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()

    obj = bpy.data.objects.new("FutoCoin", mesh)
    bpy.context.collection.objects.link(obj)
    return obj


def point_in_polygon(point, loop_verts) -> bool:
    """Even-odd ray cast, used only to drop faces that filled the hole."""
    polygon = [(v.co.x, v.co.y) for v in loop_verts]
    x, y = point
    inside = False
    j = len(polygon) - 1
    for i, (xi, yi) in enumerate(polygon):
        xj, yj = polygon[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


# ── Thickness, bevel, materials ──────────────────────────────────────────────


def gold_material(name: str, srgb: tuple, roughness: float) -> bpy.types.Material:
    """Gold, as a real metal: metallic 1, no emission.

    The old three.js coin faked its brightness with `emissive` because it had no
    environment to reflect, which is why it looked like a sticker rather than
    metal. Everything that reads as gold here comes off studio-env.hdr, so the
    material is honest and the three engines agree about what it is.
    """
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    bsdf = material.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = linear_rgba(srgb)
    bsdf.inputs["Metallic"].default_value = 1.0
    bsdf.inputs["Roughness"].default_value = roughness
    return material


def solidify_and_bevel(obj: bpy.types.Object) -> None:
    solidify = obj.modifiers.new("Thickness", "SOLIDIFY")
    solidify.thickness = DEPTH
    solidify.offset = 0.0  # grow both ways, so the coin stays centred on z=0

    bevel = obj.modifiers.new("Edges", "BEVEL")
    bevel.width = BEVEL_WIDTH
    bevel.segments = BEVEL_SEGMENTS
    bevel.limit_method = "ANGLE"
    bevel.angle_limit = math.radians(30)
    bevel.miter_outer = "MITER_ARC"

    with bpy.context.temp_override(object=obj, active_object=obj, selected_objects=[obj]):
        bpy.ops.object.modifier_apply(modifier="Thickness")
        bpy.ops.object.modifier_apply(modifier="Edges")


def assign_materials(obj: bpy.types.Object) -> None:
    face = gold_material("CoinFace", FACE_SRGB, FACE_ROUGHNESS)
    rim = gold_material("CoinRim", RIM_SRGB, RIM_ROUGHNESS)
    obj.data.materials.append(face)
    obj.data.materials.append(rim)
    for polygon in obj.data.polygons:
        polygon.material_index = 0 if abs(polygon.normal.z) >= FACE_NORMAL_Z else 1


def shade_smooth(obj: bpy.types.Object) -> None:
    """Smooth across the curved rim, sharp across the bevel's own edges.

    Blender 4.1 retired `use_auto_smooth` for the Smooth by Angle modifier, so
    this goes through the operator rather than the mesh flag.
    """
    with bpy.context.temp_override(object=obj, active_object=obj, selected_objects=[obj]):
        bpy.ops.object.shade_smooth_by_angle(angle=math.radians(35))


def stand_upright(obj: bpy.types.Object) -> None:
    """Turn the coin to face the camera, and bake that into the mesh.

    The profile is built lying in Blender's XY plane, which is the natural way
    to draw it, but both exporters convert Blender's Z-up world to the Y-up one
    that glTF and USD use — so a coin left lying flat arrives at every shell as
    a plate on a table rather than a coin facing the viewer.

    Standing it up here, once, means all three shells agree without a single
    correction rotation between them: after the conversion the coin's face looks
    down +Z and its spindle is +Y, which is exactly the axis three.js,
    RealityKit and Filament all spin about.
    """
    obj.rotation_euler = (math.radians(90), 0.0, 0.0)
    with bpy.context.temp_override(object=obj, active_object=obj, selected_objects=[obj]):
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)


def main() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)

    env_path = os.path.join(OUT, "studio-env.hdr")
    build_environment(env_path)

    coin = build_profile_mesh()
    solidify_and_bevel(coin)
    assign_materials(coin)
    shade_smooth(coin)
    stand_upright(coin)

    digest = script_digest()
    # Carried into both exports so `just coin-check` can prove the files on disk
    # came from THIS script and not an older one.
    coin["futo_coin_source_sha256"] = digest

    bpy.context.view_layer.objects.active = coin
    coin.select_set(True)

    glb_path = os.path.join(OUT, "futo-coin.glb")
    bpy.ops.export_scene.gltf(
        filepath=glb_path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_extras=True,
        export_cameras=False,
        export_lights=False,
        export_animations=False,
    )

    usdz_path = os.path.join(OUT, "futo-coin.usdz")
    bpy.ops.wm.usd_export(
        filepath=usdz_path,
        selected_objects_only=True,
        convert_orientation=True,
        export_global_up_selection="Y",
        export_global_forward_selection="NEGATIVE_Z",
        export_materials=True,
        export_cameras=False,
        export_lights=False,
        export_animation=False,
    )

    write_manifest(OUT, digest)

    print(f"[coin] source sha256 {digest}")
    print(f"[coin] wrote {glb_path}")
    print(f"[coin] wrote {usdz_path}")
    print(f"[coin] wrote {env_path}")
    print(f"[coin] mesh: {len(coin.data.vertices)} verts, {len(coin.data.polygons)} faces")


main()
