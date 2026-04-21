// EmailMessage is a runtime global in Cloudflare Workers but workers-types defines it
// only as an interface. Augment global scope so it can be used as a constructor.
declare const EmailMessage: new (
  from: string,
  to: string,
  raw: string | ReadableStream,
) => { from: string; to: string; raw: ReadableStream | string };
