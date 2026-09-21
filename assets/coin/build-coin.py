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
# Every output records this script's sha256 so a change here that was never
# regenerated fails `just coin-check` instead of shipping a stale coin.

import hashlib
import json
import math
import os
import sys
import zipfile

import bpy
import bmesh
from mathutils import Vector

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

# The studio, as an equirectangular map. 256x128 is plenty: every engine
# prefilters it into a blurred irradiance and a handful of roughness mips before
# a single pixel of coin is drawn, so detail here is thrown away immediately.
ENV_WIDTH = 256
ENV_HEIGHT = 128

# Each lobe is (direction, tightness, intensity, colour). Directions are in the
# shell frame: +Z out of the coin's face toward the viewer, +Y up the spindle.
# `tightness` is the exponent on the cosine, so a small number is a broad
# softbox and a large one is a hard spot.
ENV_LOBES = (
    # The front box. Broad, a little up and to the viewer's left. This is the
    # coin's base brightness and the single most important light here: without
    # something behind the viewer, a face-on metal disc mirrors an empty room.
    ((-0.30, 0.42, 0.86), 2.6, 6.4, (1.00, 0.985, 0.95)),
    # The key. High and to the right, angled toward the coin's edge so its
    # reflection sweeps across the face as the coin turns rather than sitting
    # still on it.
    ((0.80, 0.52, 0.30), 18.0, 24.0, (1.00, 0.97, 0.90)),
    # A second broad box on the right, so the face keeps a body of light through
    # the three-quarter angles where the front box alone left it muddy brown.
    ((0.55, 0.30, 0.78), 3.0, 4.6, (1.00, 0.96, 0.90)),
    # The fill. Low, left and cool, so the shaded half reads as shadowed metal
    # rather than as a hole.
    ((-0.85, -0.22, 0.48), 4.0, 3.2, (0.80, 0.86, 1.00)),
    # The kicker. Small and hot, behind and above, purely so the bevel has a
    # travelling spark. This is the light that makes the coin look machined.
    ((-0.25, 0.62, -0.75), 70.0, 46.0, (1.00, 0.93, 0.80)),
)

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


# ── The environment the gold reflects ────────────────────────────────────────


def build_environment(path: str) -> None:
    """Write the studio the gold reflects, as an equirectangular radiance map.

    This is generated rather than rendered. A path-traced environment would carry
    sampler noise, which makes the file different on every rebuild and defeats the
    point of the source hash recorded in the exports; and the only thing a render
    buys here is realism in an image that is never seen directly, only as a
    blurred reflection in a 160px object.

    What matters to a metal is WHERE the bright things are. A face-on disc mirrors
    whatever sits behind the viewer, so with an empty room in front of it the face
    goes black no matter how bright the sky is — which is exactly what the first
    version of this did. The front box below is what makes the coin gold; the rest
    shape it.

    The layout is written in the SHELL's frame, the one all three engines share
    after export: the coin faces +Z, its spindle is +Y, the viewer is out at +Z.
    """
    import numpy

    width, height = ENV_WIDTH, ENV_HEIGHT

    # Equirectangular, in the convention three.js, Filament and USD all read:
    # u wraps longitude from atan2(z, x), v is latitude from asin(y), and the
    # first scanline written is the TOP of the image, which is straight up.
    u = (numpy.arange(width) + 0.5) / width
    v = (numpy.arange(height) + 0.5) / height
    longitude = (u - 0.5) * 2.0 * math.pi
    elevation = (0.5 - v) * math.pi  # +pi/2 on the first row

    cos_elevation = numpy.cos(elevation)[:, None]
    dx = numpy.cos(longitude)[None, :] * cos_elevation
    dy = numpy.repeat(numpy.sin(elevation)[:, None], width, axis=1)
    dz = numpy.sin(longitude)[None, :] * cos_elevation

    # The room: a dark floor, a soft bright ceiling, and a lift through the
    # horizon so a coin seen edge-on still has something to catch.
    up = numpy.clip(dy, -1.0, 1.0)
    sky = numpy.clip(up, 0.0, 1.0) ** 1.4
    floor = numpy.clip(-up, 0.0, 1.0) ** 1.2
    base_r = 0.070 + 2.05 * sky - 0.045 * floor
    base_g = 0.074 + 2.11 * sky - 0.046 * floor
    base_b = 0.086 + 2.32 * sky - 0.052 * floor

    image = numpy.stack(
        [numpy.clip(c, 0.004, None) for c in (base_r, base_g, base_b)], axis=-1
    )

    for direction, tightness, intensity, colour in ENV_LOBES:
        length = math.sqrt(sum(c * c for c in direction))
        nx, ny, nz = (c / length for c in direction)
        lobe = numpy.clip(dx * nx + dy * ny + dz * nz, 0.0, 1.0) ** tightness
        for channel in range(3):
            image[:, :, channel] += lobe * intensity * colour[channel]

    write_radiance_hdr(path, image)


def write_radiance_hdr(path: str, image) -> None:
    """Save a float RGB array as a flat (un-run-length-encoded) Radiance .hdr.

    Flat RGBE is the most widely readable form of the format and costs nothing at
    this size. Blender, three.js's RGBELoader and Filament's cmgen all take it.
    """
    import numpy

    height, width, _ = image.shape
    peak = image.max(axis=2)
    mantissa, exponent = numpy.frexp(peak)
    # frexp gives peak = mantissa * 2**exponent with mantissa in [0.5, 1); the
    # RGBE convention stores mantissa*256 against a biased exponent.
    scale = numpy.where(peak > 1e-32, mantissa * 256.0 / numpy.maximum(peak, 1e-32), 0.0)
    rgbe = numpy.zeros((height, width, 4), dtype=numpy.uint8)
    for channel in range(3):
        rgbe[:, :, channel] = numpy.clip(image[:, :, channel] * scale, 0, 255).astype(
            numpy.uint8
        )
    rgbe[:, :, 3] = numpy.where(peak > 1e-32, numpy.clip(exponent + 128, 0, 255), 0).astype(
        numpy.uint8
    )

    with open(path, "wb") as handle:
        handle.write(b"#?RADIANCE\n")
        handle.write(b"FORMAT=32-bit_rle_rgbe\n\n")
        handle.write(f"-Y {height} +X {width}\n".encode("ascii"))
        handle.write(rgbe.tobytes())


# ── Export ───────────────────────────────────────────────────────────────────


def script_digest() -> str:
    with open(os.path.abspath(__file__), "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def content_digest(path: str) -> str:
    """The hash of what a file MEANS, not of its bytes.

    For everything but the .usdz those are the same thing, and two runs of this
    script produce byte-identical .glb and .hdr files. A .usdz is a zip, and a
    zip stamps every entry with the time it was written, so its bytes change on
    every rebuild while its contents do not. Hashing the entries instead keeps
    `just coin-check` quiet about a regeneration that changed nothing, and still
    catches one that changed something.
    """
    if path.endswith(".usdz"):
        with zipfile.ZipFile(path) as archive:
            digest = hashlib.sha256()
            for name in sorted(archive.namelist()):
                digest.update(name.encode("utf-8"))
                digest.update(archive.read(name))
            return digest.hexdigest()
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def write_manifest(digest: str) -> None:
    """Record what this run produced, so a stale export cannot ship unnoticed.

    CI has no Blender, so it cannot regenerate the coin to check it. What it CAN
    do is verify two things cheaply: that the script on disk is the one the
    outputs were built from, and that nobody hand-edited an output afterwards
    (M8 — generated files are never edited in place). Both are just hashes.

    `just coin-check` is that gate; `just coin` is how you make it pass again.
    """
    outputs = {}
    for name in ("futo-coin.glb", "futo-coin.usdz", "studio-env.hdr"):
        outputs[name] = content_digest(os.path.join(OUT, name))
    manifest = {
        "source": "build-coin.py",
        "sourceSha256": digest,
        "blender": bpy.app.version_string.split()[0],
        "outputs": outputs,
    }
    with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2, sort_keys=True)
        handle.write("\n")


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

    write_manifest(digest)

    print(f"[coin] source sha256 {digest}")
    print(f"[coin] wrote {glb_path}")
    print(f"[coin] wrote {usdz_path}")
    print(f"[coin] wrote {env_path}")
    print(f"[coin] mesh: {len(coin.data.vertices)} verts, {len(coin.data.polygons)} faces")


main()
