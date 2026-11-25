// `Env` itself is generated from wrangler.jsonc into worker-configuration.d.ts
// by `bunx wrangler types`. This adds the one binding that is optional: the
// worker runs without it, and only `save: true` needs it.
interface Env {
  /** Optional R2 bucket. Present only when the binding is uncommented in wrangler.jsonc. */
  MEDIA?: R2Bucket
}
