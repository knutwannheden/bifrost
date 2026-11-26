import fs from 'node:fs';
import path from 'node:path';

export function readEpicTemplates(pluginDir) {
  const directory = path.join(pluginDir, 'skills', 'epic', 'templates');
  const ids = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => path.basename(entry.name, '.md'))
    .sort();

  return ids.map((id) => {
    const source = fs.readFileSync(path.join(directory, `${id}.md`), 'utf8');
    const [, heading, body] = source.match(/^# ([^\n]+)\n([\s\S]*)$/) ?? [];
    const title = heading?.trim();
    const text = body?.trim();
    if (!title || !text) throw new Error(`Epic template "${id}.md" needs a title and prompt text`);
    return { id, title, text };
  });
}
