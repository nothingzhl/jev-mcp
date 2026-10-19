// Preloaded only by a CLI subprocess test. Never contacts an external service.
globalThis.fetch = async () => {
  process.stderr.write("SYNTHETIC_FETCH\n");
  return Response.json({ error: "SYNTHETIC_PRIVATE_UPSTREAM_BODY" }, { status: 401 });
};
