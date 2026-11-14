// Settings of the plugins in plugins/ (each plugin checks its own with its schema at start).
import { definePluginSettings } from '../core/config/public/index.ts';

export default definePluginSettings({
  'example-notes': { maxNotes: 50 },
});
