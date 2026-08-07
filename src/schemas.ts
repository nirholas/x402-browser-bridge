// GENERATED from openapi.json — do not edit by hand.
//
// Per-route invocation contracts published inside the x402 402 challenge as
// `accepts[].outputSchema`. `input` tells an agent how to build the request
// (method, query/path params, JSON body fields); `output` is the JSON Schema of
// the 200 body it gets back once payment settles.
//
// Deriving these from `openapi.json` keeps the runtime challenge — which the
// x402scan discovery spec treats as authoritative — from ever contradicting the
// published spec. Regenerate whenever a paid route's parameters or response
// schema change.
//
// Keys match the paywall route map in `server.ts` exactly (`"<METHOD> <path>"`,
// with `:param` for path segments).

import type { RouteSchema } from "./payments.js";

export const ROUTE_SCHEMAS: Record<string, RouteSchema> = {
  "POST /run/:flow": {
    "input": {
      "type": "http",
      "method": "POST",
      "pathParams": {
        "flow": {
          "type": "string",
          "x-required": true
        }
      },
      "bodyType": "json",
      "bodyFields": {}
    },
    "output": {
      "type": "object",
      "required": [
        "run"
      ],
      "properties": {
        "run": {
          "type": "object",
          "properties": {
            "payload": {
              "type": "object",
              "properties": {
                "flow": {
                  "type": "string"
                },
                "status": {
                  "type": "string",
                  "enum": [
                    "completed",
                    "failed"
                  ]
                },
                "startedAt": {
                  "type": "string",
                  "format": "date-time"
                },
                "finishedAt": {
                  "type": "string",
                  "format": "date-time"
                },
                "durationMs": {
                  "type": "number"
                },
                "finalUrl": {
                  "type": [
                    "string",
                    "null"
                  ]
                },
                "extracted": {
                  "type": "object",
                  "description": "Values named by the flow's extract block"
                },
                "screenshots": {
                  "type": "object",
                  "additionalProperties": {
                    "type": "string",
                    "description": "base64 PNG, no data-URI prefix"
                  }
                },
                "steps": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "index": {
                        "type": "integer"
                      },
                      "action": {
                        "type": "string",
                        "enum": [
                          "goto",
                          "click",
                          "type",
                          "select",
                          "press",
                          "waitFor",
                          "waitForText",
                          "wait",
                          "scroll",
                          "screenshot"
                        ]
                      },
                      "label": {
                        "type": "string"
                      },
                      "status": {
                        "type": "string",
                        "enum": [
                          "ok",
                          "skipped",
                          "failed"
                        ]
                      },
                      "durationMs": {
                        "type": "number"
                      },
                      "detail": {
                        "type": "string"
                      },
                      "error": {
                        "type": "string"
                      }
                    }
                  }
                },
                "error": {
                  "type": "string",
                  "description": "Present when status is failed"
                },
                "inputs": {
                  "type": "object"
                }
              }
            },
            "signature": {
              "type": "string"
            },
            "algorithm": {
              "type": "string",
              "const": "HMAC-SHA256"
            }
          }
        },
        "flow": {
          "type": "object",
          "properties": {
            "name": {
              "type": "string"
            },
            "description": {
              "type": "string"
            },
            "price": {
              "type": "string"
            }
          }
        },
        "paidWith": {
          "type": "object",
          "properties": {
            "success": {
              "type": "boolean"
            },
            "rail": {
              "type": "string",
              "enum": [
                "evm",
                "solana"
              ]
            },
            "network": {
              "type": "string"
            },
            "transaction": {
              "type": "string"
            },
            "payer": {
              "type": "string"
            },
            "amount": {
              "type": "string"
            },
            "asset": {
              "type": "string"
            },
            "resource": {
              "type": "string"
            }
          }
        }
      }
    }
  },
};
