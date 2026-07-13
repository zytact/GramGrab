import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { Schema } from 'effect';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');

export const REQUIRED_CONFIG_KEYS = [
  'IG_HIGHLIGHT_ID',
  'IG_STORY_USERNAME',
  'IG_AVATAR_USERNAME',
  'IG_TRAY_USERNAME',
  'IG_PROFILE_USERNAME',
  'IG_POST_IMAGE',
  'IG_POST_VIDEO',
  'IG_POST_SIDECAR',
] as const;

export const CONFIG_TOKEN = '__IG_FIXTURE_CAPTURE_CONFIG__';

const usernameKeys = [
  'IG_STORY_USERNAME',
  'IG_AVATAR_USERNAME',
  'IG_TRAY_USERNAME',
  'IG_PROFILE_USERNAME',
] as const;
const postKeys = ['IG_POST_IMAGE', 'IG_POST_VIDEO', 'IG_POST_SIDECAR'] as const;
const usernamePattern = /^[A-Za-z0-9._]{1,30}$/;
const highlightIdPattern = /^\d+$/;
const shortcodePattern = /^[A-Za-z0-9_-]+$/;

const HighlightIdSchema = Schema.String.pipe(
  Schema.filter(value => highlightIdPattern.test(value), {
    message: () => 'must contain only digits',
  })
);
const UsernameSchema = Schema.String.pipe(
  Schema.filter(value => usernamePattern.test(value), {
    message: () => 'must be a valid Instagram username',
  })
);
const PostInputSchema = Schema.String.pipe(
  Schema.filter(
    value => {
      try {
        normalizeShortcode(value);
        return true;
      } catch {
        return false;
      }
    },
    {
      message: () => 'must be a public Instagram post/reel URL or shortcode',
    }
  )
);

const CaptureConfigSchema = Schema.Struct({
  IG_HIGHLIGHT_ID: HighlightIdSchema,
  IG_STORY_USERNAME: UsernameSchema,
  IG_AVATAR_USERNAME: UsernameSchema,
  IG_TRAY_USERNAME: UsernameSchema,
  IG_PROFILE_USERNAME: UsernameSchema,
  IG_POST_IMAGE: PostInputSchema,
  IG_POST_VIDEO: PostInputSchema,
  IG_POST_SIDECAR: PostInputSchema,
});

type CaptureConfig = Schema.Schema.Type<typeof CaptureConfigSchema>;

function readRequiredValue(values: Record<string, string | undefined>, key: string): string {
  const value = values[key]?.trim();
  if (!value) throw new Error(`Missing required configuration: ${key}`);
  return value;
}

export function normalizeShortcode(input: string): string {
  const raw = input.trim();
  const urlMatch = raw.match(/instagram\.com\/(?:[^/]+\/)?(?:p|reel|tv)\/([^/?#]+)/i);
  const shortcode = urlMatch?.[1] ?? raw.replace(/^\/+|\/+$/g, '');

  if (!shortcodePattern.test(shortcode)) {
    throw new Error('must be a public Instagram post/reel URL or shortcode');
  }

  return shortcode;
}

export function validateConfig(values: Record<string, string | undefined>): CaptureConfig {
  const config = {
    IG_HIGHLIGHT_ID: readRequiredValue(values, 'IG_HIGHLIGHT_ID'),
    IG_STORY_USERNAME: readRequiredValue(values, 'IG_STORY_USERNAME'),
    IG_AVATAR_USERNAME: readRequiredValue(values, 'IG_AVATAR_USERNAME'),
    IG_TRAY_USERNAME: readRequiredValue(values, 'IG_TRAY_USERNAME'),
    IG_PROFILE_USERNAME: readRequiredValue(values, 'IG_PROFILE_USERNAME'),
    IG_POST_IMAGE: readRequiredValue(values, 'IG_POST_IMAGE'),
    IG_POST_VIDEO: readRequiredValue(values, 'IG_POST_VIDEO'),
    IG_POST_SIDECAR: readRequiredValue(values, 'IG_POST_SIDECAR'),
  };

  if (!Schema.is(HighlightIdSchema)(config.IG_HIGHLIGHT_ID)) {
    throw new Error('IG_HIGHLIGHT_ID must contain only digits');
  }

  for (const key of usernameKeys) {
    if (!Schema.is(UsernameSchema)(config[key])) {
      throw new Error(`${key} must be a valid Instagram username`);
    }
  }

  for (const key of postKeys) {
    if (!Schema.is(PostInputSchema)(config[key])) {
      throw new Error(`${key} must be a public Instagram post/reel URL or shortcode`);
    }
  }

  return Schema.decodeUnknownSync(CaptureConfigSchema)({
    ...config,
    IG_POST_IMAGE: normalizeShortcode(config.IG_POST_IMAGE),
    IG_POST_VIDEO: normalizeShortcode(config.IG_POST_VIDEO),
    IG_POST_SIDECAR: normalizeShortcode(config.IG_POST_SIDECAR),
  });
}

export function renderCaptureScript(template: string, config: CaptureConfig): string {
  const token = `'${CONFIG_TOKEN}'`;
  const occurrences = template.split(token).length - 1;
  if (occurrences !== 1) {
    throw new Error(`Capture template must contain ${CONFIG_TOKEN} exactly once`);
  }

  return template.replace(token, JSON.stringify(JSON.stringify(config)));
}

export async function generateCaptureScript({
  envPath = resolve(repositoryRoot, '.env'),
  templatePath = resolve(repositoryRoot, 'scripts/capture-ig-fixtures.mjs'),
  outputPath = resolve(repositoryRoot, '.local/capture-ig-fixtures.mjs'),
} = {}): Promise<{ readonly outputPath: string }> {
  const [envSource, template] = await Promise.all([
    readFile(envPath, 'utf8'),
    readFile(templatePath, 'utf8'),
  ]);
  const config = validateConfig(parseEnv(envSource));
  const output = renderCaptureScript(template, config);

  new Script(output, { filename: outputPath });
  await mkdir(dirname(outputPath), { recursive: true });

  const temporaryPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, output, 'utf8');
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }

  return { outputPath };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  generateCaptureScript().then(
    ({ outputPath }) => process.stdout.write(`Generated ${outputPath}\n`),
    error => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  );
}
