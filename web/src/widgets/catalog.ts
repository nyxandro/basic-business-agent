// The widgets the agent may draw in the chat (spec, section 8.31): CopilotKit's standard catalog without the components
// the owner left out (contracts/src/widgets.ts), under our catalog id — the server builds the same catalog for the
// descriptions and the check (core/widgets/catalog.ts; a test compares the two).
import { WIDGET_CATALOG_ID, WIDGET_OMITTED } from '@bba/contracts';
import { createGenerativeUI, standardUI, type GenerativeUIConfig } from '@copilotkit/react-core/generative-ui';
import { widgetOverrides } from './overrides.tsx';

export const widgetsUI = createGenerativeUI({ id: WIDGET_CATALOG_ID, extends: [standardUI.omit(WIDGET_OMITTED)], overrides: widgetOverrides, components: {} });

// No agent gets CopilotKit's own envelope (`agentIds: []`): it would give the agent CopilotKit's `render_ui` and its
// guide, and our server gives both itself. The provider still runs the engine that draws a screen and turns a click
// into a message of the person.
export const WIDGETS_CONFIG: GenerativeUIConfig = { ui: widgetsUI, agentIds: [] };
