# Local-only builds have no remote platform/container requirements.
load("@builtin//struct.star", "module")

def local_platforms(ctx):
    return {"default": {}, "large": {}}

backend = module("backend", platform_properties = local_platforms)
