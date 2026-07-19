# RPC handlers

## `eth_supportedEntryPoints`

Call `POST /{chainId}/rpc` with the following request body:

```json
{
  "jsonrpc": "2.0",
  "method": "eth_supportedEntryPoints",
  "params": [],
  "id": 1
}
```

Response:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": ["0x0000000071727De22E5E9d8BAf0edAc6f37da032"]
}
```

The address list is defined by the `SUPPORTED_ENTRY_POINTS` constant in `supported_entry_points.rs`. The first address is the Bundler's preferred EntryPoint. The current implementation returns the same list for every `chainId`.
