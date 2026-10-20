# The studio the coin's gold reflects: the lamp layout, the equirectangular map built
# from it, and the Radiance .hdr writer. Imported by build-coin.py, which owns the coin
# itself; `just coin-check` hashes every .py in this folder, so an edit here that was
# never regenerated fails the gate just like an edit there.

import math

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

