// The envelope of CopilotKit's browser out of a run (spec, section 8.31). On a press of a widget the browser puts its
// envelope — the catalog, the surfaces, the action — into `forwardedProps.copilotkit.ui`, though the provider sends
// none to the agent otherwise (`agentIds: []`). CopilotKit's runtime then switches its generative UI layers on for
// that turn, and its `render_ui` — carried out by the browser, without our server's check — takes the place of ours
// (core test 20.11). The model needs none of it: the person's message with the label and the values is in the
// conversation. The rest of the request stays as it came, its abort signal too.

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function withoutWidgetEnvelope(request: Request, body: unknown): Request {
  if (!isObject(body) || !isObject(body.forwardedProps)) return request;
  const copilotkit = body.forwardedProps.copilotkit;
  if (!isObject(copilotkit) || !('ui' in copilotkit)) return request;
  const { ui: _envelope, ...rest } = copilotkit;
  const forwardedProps = { ...body.forwardedProps, copilotkit: rest };
  const headers = new Headers(request.headers);
  // The body is written anew: the length of the old one would cut or stall it.
  headers.delete('content-length');
  return new Request(request, { body: JSON.stringify({ ...body, forwardedProps }), headers });
}
