---
name: browser-flow-api
description: Declare a website flow in YAML, serve it as an x402-paid API driven by Puppeteer, and call it to get extracted data and screenshots. Use when an agent needs to complete a click path that has no API, on a site the operator is allowed to automate.
---

# x402-browser-bridge

You POST a flow's inputs, a headless browser walks the declared click path, and
the response carries the extracted data, step log and screenshots, signed with
HMAC. Automating a site you do not own may breach its terms: the bundled flows
(`flows/demo-booking.yaml`, `flows/demo-catalog.yaml`) target pages this repo
serves itself, and each flow limits navigation to its `allowHosts`.

## Run the server

It is a self-hosted Node server (Express, Node 22.12 or newer). Run it from a clone:

```bash
git clone https://github.com/nirholas/x402-browser-bridge && cd x402-browser-bridge
npm install
cp .env.example .env     # then adjust; see the comments in the file
npm run dev              # tsx src/server.ts, listens on PORT (default 4034)
```

`npm run build` then `npm start` runs the compiled server. `npm run client`
runs `examples/agent-client.ts`, a reference paying client. Set `PAY_TO_ADDRESS`
and `SOLANA_PAY_TO_ADDRESS` to your own wallets to be paid yourself.

Related settings: `FLOWS_DIR` (default `flows`), `HEADLESS` (default true),
`PUPPETEER_EXECUTABLE_PATH`, `EXTRA_ALLOW_HOSTS`, `SIGNING_SECRET`.

## Routes

| Route | Price | Notes |
| --- | --- | --- |
| `GET /flows` | free | catalogue: name, price, inputs schema, `extracts`, `allowHosts`. Read first |
| `POST /run/:flow` | per flow, $0.05 for the bundled ones | body is the flow's declared inputs as JSON |
| `POST /verify` | free | body `{ payload, signature }`, returns `{ valid }` |
| `GET /health` | free | includes `browserAvailable` |
| `GET /.well-known/x402` | free | |

Inputs are validated against each flow's `required` and `pattern` before
payment, so a bad request costs nothing. `run.payload.status` is `completed` or
`failed`; a failed run still settled, so read `extracted` and the step log
before retrying. Screenshots are raw base64 PNG. If `browserAvailable` is false
a paid run returns a free 503.

## Writing a flow

A flow is a YAML file in `FLOWS_DIR` with `name`, `description`, `price`
(for example `"$0.05"`), `allowHosts`, `authorized`, `timeoutMs`, `inputs`,
and steps. Copy `flows/demo-booking.yaml` as the template.

## Example

```bash
curl -s http://localhost:4034/flows
curl -s -X POST http://localhost:4034/run/demo-booking -H 'content-type: application/json' \
  -d '{"name":"Ada Lovelace","email":"ada@example.com","date":"2026-09-01","partySize":"4"}'   # 402 first
```

## Paying (x402)

Paid routes follow the x402 protocol. An unpaid call returns HTTP 402 with an
`accepts` array listing USDC on Base and USDC on Solana. Sign for one rail,
retry with the base64 payload in the `X-PAYMENT` header, and the 200 body
carries the result; the settlement receipt is in the `X-PAYMENT-RESPONSE`
header. Clients: `x402-fetch` (EVM), `@three-ws/x402-payment-modal` (browser,
both rails), or any x402 client. The rail networks are chosen by `NETWORK`
(EVM, `base-sepolia` by default) and `SOLANA_NETWORK` in `.env`; see
`.env.example`. Settlement moves real USDC on the chosen network: show the user
the recipient, amount and network and get an explicit yes before every paid call.
