# Resolve a multi-platform CI image digest

When a CI image must support several architectures, resolve the top-level image index:

```bash
docker buildx imagetools inspect docker.io/library/alpine:3.21
```

Check the top-level `MediaType` is `application/vnd.oci.image.index.v1+json` or
`application/vnd.docker.distribution.manifest.list.v2+json`. Its top-level `Digest:` identifies
the complete index. Confirm the required platforms appear under `Manifests`, then pin
`<image>@sha256:<index-digest>`. Preserve intentional platform-specific pins and job constraints.

`docker manifest inspect -v` can return an array of child descriptors. Its
`[0].Descriptor.digest` selects one platform; successful GitLab CI lint does not establish that
an image pin supports the job's other architectures. Docker documents the index and child fields
in [imagetools inspect](https://docs.docker.com/reference/cli/docker/buildx/imagetools/inspect/).

For a machine-readable platform check, inspect the same reference's index:

```bash
docker buildx imagetools inspect --raw docker.io/library/alpine:3.21
```

At verification on 2026-10-24, `alpine:3.21` resolved to index
`sha256:ee16d92f96db08d9d2d07da48555a27f3a69d8f0759021dbc601195ed0d2b5bd` and advertised both
`linux/amd64` and `linux/arm64`. The verbose array's first descriptor was instead the amd64 child
`sha256:f765c92e59538d44c6946f8073bdbffd2e8d5916981161faed1b30aa0ef0c2c5`.
This is a reproduced diagnostic example; resolve the intended image when changing its pin.
