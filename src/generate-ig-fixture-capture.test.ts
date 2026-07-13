import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { describe, expect, it } from 'vite-plus/test';
import {
  CONFIG_TOKEN,
  REQUIRED_CONFIG_KEYS,
  generateCaptureScript,
  renderCaptureScript,
  validateConfig,
} from '../scripts/generate-ig-fixture-capture.ts';

const template = `{
  const CAPTURE_CONFIG = JSON.parse('${CONFIG_TOKEN}');
  globalThis.captureConfig = CAPTURE_CONFIG;
}`;
const validConfig = {
  IG_HIGHLIGHT_ID: '12345678901234567',
  IG_STORY_USERNAME: 'story_user',
  IG_AVATAR_USERNAME: 'avatar.user',
  IG_TRAY_USERNAME: 'tray_user',
  IG_PROFILE_USERNAME: 'profile.user',
  IG_POST_IMAGE: 'https://www.instagram.com/p/image_123/?utm_source=test',
  IG_POST_VIDEO: 'https://www.instagram.com/reel/video-123/',
  IG_POST_SIDECAR: 'sidecar_123',
};

type CaptureConfig = Record<(typeof REQUIRED_CONFIG_KEYS)[number], string>;

function dotenv(config: CaptureConfig) {
  return `${Object.entries(config)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')}\n`;
}

async function temporaryPaths() {
  const directory = await mkdtemp(join(tmpdir(), 'gramgrab-fixture-capture-'));
  return {
    envPath: join(directory, '.env'),
    outputPath: join(directory, '.local', 'capture-ig-fixtures.mjs'),
    templatePath: join(directory, 'template.mjs'),
  };
}

describe('generateCaptureScript', () => {
  it('generates deterministic, syntactically valid output with normalized post inputs', async () => {
    const paths = await temporaryPaths();
    await Promise.all([
      writeFile(paths.envPath, dotenv(validConfig)),
      writeFile(paths.templatePath, template),
    ]);

    await generateCaptureScript(paths);
    const first = await readFile(paths.outputPath, 'utf8');
    await generateCaptureScript(paths);
    const second = await readFile(paths.outputPath, 'utf8');

    expect(second).toBe(first);
    expect(() => new Script(first)).not.toThrow();

    const context: Record<string, unknown> = {};
    new Script(first).runInNewContext(context);
    expect(context.captureConfig).toEqual({
      ...validConfig,
      IG_POST_IMAGE: 'image_123',
      IG_POST_VIDEO: 'video-123',
    });
  });

  it.each(REQUIRED_CONFIG_KEYS)('rejects missing %s before writing output', async key => {
    const paths = await temporaryPaths();
    const config = { ...validConfig, [key]: '' };
    await Promise.all([
      writeFile(paths.envPath, dotenv(config)),
      writeFile(paths.templatePath, template),
    ]);

    await expect(generateCaptureScript(paths)).rejects.toThrow(
      `Missing required configuration: ${key}`
    );
  });

  it('reports invalid highlight IDs, usernames, and post inputs', () => {
    expect(() => validateConfig({ ...validConfig, IG_HIGHLIGHT_ID: 'not-an-id' })).toThrow(
      'IG_HIGHLIGHT_ID must contain only digits'
    );
    expect(() => validateConfig({ ...validConfig, IG_STORY_USERNAME: 'not a username' })).toThrow(
      'IG_STORY_USERNAME must be a valid Instagram username'
    );
    expect(() => validateConfig({ ...validConfig, IG_POST_IMAGE: 'not a post' })).toThrow(
      'IG_POST_IMAGE must be a public Instagram post/reel URL or shortcode'
    );
  });

  it('uses JSON encoding so escaping-sensitive configuration remains valid JavaScript', () => {
    const escapingSensitiveConfig = {
      ...validConfig,
      IG_STORY_USERNAME: 'quote"\\newline\nseparator\u2028',
    };
    const output = renderCaptureScript(template, escapingSensitiveConfig);

    expect(() => new Script(output)).not.toThrow();
    const context: Record<string, unknown> = {};
    new Script(output).runInNewContext(context);
    expect(context.captureConfig).toEqual(escapingSensitiveConfig);
  });

  it('does not replace an existing output when validation fails', async () => {
    const paths = await temporaryPaths();
    await Promise.all([
      writeFile(paths.envPath, dotenv({ ...validConfig, IG_POST_VIDEO: 'bad post input' })),
      writeFile(paths.templatePath, template),
    ]);
    await mkdir(join(paths.outputPath, '..'), { recursive: true });
    await writeFile(paths.outputPath, 'previous output');

    await expect(generateCaptureScript(paths)).rejects.toThrow('IG_POST_VIDEO');
    await expect(readFile(paths.outputPath, 'utf8')).resolves.toBe('previous output');
  });
});
