"""Launch the actual upstream API with the external DCU adapter."""
def main():
    from dcu_adapter import configure, install, load_target
    configure(load_target())  # Identity guard BEFORE native config/API-key read.
    from opensandbox_server.config import load_config
    config = load_config()
    if config.runtime.type != "docker" or config.docker.network_mode != "bridge":
        raise RuntimeError("requires native Docker runtime and bridge networking")
    if config.secure_runtime is not None:
        raise RuntimeError("secure_runtime unsupported; fixed runc required")
    if not config.server.api_key:
        raise RuntimeError("set native OPENSANDBOX_SERVER_API_KEY")
    install()
    from opensandbox_server.main import app
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=18090, workers=1, reload=False)


if __name__ == "__main__":
    main()
