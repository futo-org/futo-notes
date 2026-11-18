# Cirrus has no YAML include. The Cirrus CLI appends the string main() returns
# to .cirrus.yml before parsing the config, so these task files and .cirrus.yml
# read as one YAML document. fs.read returns None for a missing file, which
# fails the join instead of silently dropping its tasks.
load("cirrus", "fs")

TASK_FILES = [
    "ci/cirrus/ios-test.yml",
    "ci/cirrus/macos-build.yml",
    "ci/cirrus/ios-build.yml",
]

def main(ctx):
    return "\n".join([fs.read(path) for path in TASK_FILES])
