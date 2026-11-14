// The CopilotKit runtime of the server (core/chat/copilot.ts); the session cookie goes with it.
export const COPILOT_RUNTIME_URL = '/app/api/copilotkit';

// The development Inspector of CopilotKit sends usage events to telemetry.copilotkit.ai and loads
// fonts from Google; the Intelligence indicator belongs to their cloud. Employees' browsers of a
// closed installation talk only to our server, so both stay off in every build.
export const COPILOT_PRIVACY = { enableInspector: false, showIntelligenceIndicator: false } as const;
