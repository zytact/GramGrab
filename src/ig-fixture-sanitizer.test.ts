import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import {
  discoverEntities,
  entityForLeaf,
  type ActualPath,
  type ClassifiedLeaf,
  type JsonValue,
} from '../scripts/ig-fixture-sanitizer/entities.ts';
import {
  FIXTURE_FILENAMES,
  type EntityKind,
  type FixtureFilename,
  type IdentifierNamespace,
  type PolicyRule,
} from '../scripts/ig-fixture-sanitizer/policy.ts';
import { isJsonValue, sanitizeBatch } from '../scripts/ig-fixture-sanitizer/sanitize.ts';

interface EntityLeafOptions {
  readonly filename: FixtureFilename;
  readonly path: ActualPath;
  readonly normalizedPath: string;
  readonly value: string | number;
  readonly entity: EntityKind;
  readonly recordPath: string;
  readonly role: string;
  readonly namespace?: IdentifierNamespace;
}

const entityLeaf = (options: EntityLeafOptions): ClassifiedLeaf => {
  const rule: PolicyRule = {
    path: options.normalizedPath,
    types: [typeof options.value === 'number' ? 'number' : 'string'],
    action: {
      tag: 'entityField',
      entity: options.entity,
      recordPath: options.recordPath,
      role: options.role,
      namespace: options.namespace,
    },
  };
  return {
    filename: options.filename,
    path: options.path,
    normalizedPath: options.normalizedPath,
    value: options.value,
    rule,
  };
};

const entityUrlLeaf = (
  filename: FixtureFilename,
  path: ActualPath,
  normalizedPath: string,
  recordPath: string,
  value: string
): ClassifiedLeaf => ({
  filename,
  path,
  normalizedPath,
  value,
  rule: {
    path: normalizedPath,
    types: ['string'],
    action: {
      tag: 'url',
      role: 'PROFILE_PICTURE',
      entity: 'PERSON',
      recordPath,
    },
  },
});

const referenceFor = (leaf: ClassifiedLeaf, leaves: ReadonlyArray<ClassifiedLeaf>) => {
  const result = discoverEntities(leaves);
  expect(result.violations).toHaveLength(0);
  expect(result.index).toBeDefined();
  return result.index ? entityForLeaf(leaf, result.index) : undefined;
};

const shortcodeVideo = (): JsonValue => ({
  data: {
    xdt_shortcode_media: {
      __typename: 'SyntheticVideoType',
      id: 73001,
      shortcode: 'synthetic-media-code',
      title: '',
      display_url: 'https://media.synthetic.example/display?token=synthetic-secret',
      display_resources: [
        {
          src: 'https://media.synthetic.example/resource?signature=synthetic-secret',
          config_height: 720,
          config_width: 720,
        },
      ],
      media_preview: 'synthetic-preview-secret',
      tracking_token: 'synthetic-tracking-secret',
      owner: {
        id: 'person-73001',
        username: 'synthetic_person',
        full_name: 'Synthetic Person',
        profile_pic_url: 'https://avatar.synthetic.example/picture?token=synthetic-secret',
      },
      location: {
        id: 'location-73001',
        name: 'Synthetic Place',
        slug: 'synthetic-place',
        has_public_page: true,
        address_json: JSON.stringify({
          city_name: 'Synthetic City',
          country_code: 'ZZ',
          exact_city_match: false,
          exact_country_match: false,
          exact_region_match: false,
          region_name: 'Synthetic Region',
          street_address: '',
          zip_code: null,
        }),
      },
      clips_music_attribution_info: {
        audio_id: 'audio-73001',
        artist_name: 'Synthetic Artist',
        song_name: 'Synthetic Song',
        should_mute_audio_reason: '',
        should_mute_audio: false,
        uses_original_audio: false,
      },
    },
  },
  errors: null,
});

const oneFile = (
  filename: FixtureFilename,
  value: JsonValue
): ReadonlyMap<FixtureFilename, JsonValue> => new Map([[filename, value]]);

const allStrings = (value: JsonValue): ReadonlyArray<string> => {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return [];
  if (Array.isArray(value)) return value.flatMap(allStrings);
  return Object.values(value).flatMap(allStrings);
};

describe('IG fixture sanitizer policy and transformation', () => {
  it('fails closed for unknown paths and unexpected types without reporting values', () => {
    const result = sanitizeBatch(
      oneFile('avatar.json', {
        status: 42,
        synthetic_unknown: 'synthetic-secret-that-must-not-appear',
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations).toHaveLength(2);
    const diagnostics = JSON.stringify(result.violations);
    expect(diagnostics).not.toContain('synthetic-secret-that-must-not-appear');
    expect(result.violations.map(violation => violation.category).sort()).toEqual([
      'type',
      'unknown-path',
    ]);
  });

  it('rejects the wrong type for a reviewed empty container', () => {
    const result = sanitizeBatch(
      oneFile('avatar.json', {
        status: 'ok',
        user: [],
      })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations).toContainEqual({
        filename: 'avatar.json',
        path: 'user',
        expected: 'object',
        observed: 'array',
        category: 'type',
      });
    }
  });

  it('models a guardian as a distinct Person entity', () => {
    const result = sanitizeBatch(
      oneFile('web-profile-info.json', {
        status: 'ok',
        data: {
          user: {
            id: 'synthetic-profile-person-id',
            guardian_id: 'synthetic-guardian-person-id',
          },
        },
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const serialized = JSON.stringify(result.files.get('web-profile-info.json'));
    expect(serialized).toContain('SANITIZED_PERSON_1_ID');
    expect(serialized).toContain('SANITIZED_PERSON_2_GUARDIAN_ID');
  });

  it('preserves structural literals, timestamps, GraphQL messages, and scans_profile', () => {
    const structural = sanitizeBatch(
      new Map<FixtureFilename, JsonValue>([
        [
          'highlights.json',
          {
            data: { reels_media: [] },
            errors: [
              {
                message: 'Synthetic GraphQL structural message',
                path: ['query', 1],
                severity: 'NOTICE',
              },
            ],
          },
        ],
        [
          'highlights-tray.json',
          {
            status: 'ok',
            highlights_tray_type: 'synthetic-structural-literal',
            tray: [
              {
                id: 'synthetic-highlight-id',
                created_at: 1_700_000_000,
                cover_media: {
                  media_id: 'synthetic-cover-id',
                  cropped_image_version: {
                    url: 'https://cover.synthetic.example/image',
                    scans_profile: 'synthetic-encoding-profile',
                  },
                },
              },
            ],
          },
        ],
      ])
    );
    expect(structural.ok).toBe(true);
    if (!structural.ok) return;
    const serialized = JSON.stringify([...structural.files.values()]);
    expect(serialized).toContain('Synthetic GraphQL structural message');
    expect(serialized).toContain('synthetic-encoding-profile');
    expect(serialized).toContain('1700000000');
    expect(serialized).toContain('synthetic-structural-literal');
  });

  it('uses category placeholders, numeric sentinels, safe URLs, and encoded address JSON', () => {
    const result = sanitizeBatch(oneFile('shortcode-video.json', shortcodeVideo()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const output = result.files.get('shortcode-video.json');
    expect(output).toBeDefined();
    if (!output) return;
    const serialized = JSON.stringify(output);
    expect(serialized).toContain('SANITIZED_MEDIA_1_SHORTCODE');
    expect(serialized).toContain('SANITIZED_PERSON_1_USERNAME');
    expect(serialized).toContain('SANITIZED_LOCATION_1_CITY_NAME');
    expect(serialized).toContain('SANITIZED_AUDIO_1_ARTIST');
    expect(serialized).toContain('SANITIZED_MEDIA_PREVIEW_1');
    expect(serialized).toContain('-2000001');
    expect(serialized).not.toContain('synthetic-secret');
    const urls = allStrings(output).filter(value => /^https?:\/\//.test(value));
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every(value => new URL(value).hostname === 'sanitized.invalid')).toBe(true);
  });

  it('preserves nulls and empty strings and rejects malformed embedded JSON', () => {
    const value = shortcodeVideo();
    const first = sanitizeBatch(oneFile('shortcode-video.json', value));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(JSON.stringify(first.files.get('shortcode-video.json'))).toContain('"title":""');
    const firstOutput = first.files.get('shortcode-video.json');
    expect(firstOutput).toBeDefined();
    if (firstOutput) {
      expect(allStrings(firstOutput).some(text => text.includes('"zip_code":null'))).toBe(true);
    }

    const malformed = sanitizeBatch(
      oneFile('shortcode-video.json', {
        data: {
          xdt_shortcode_media: {
            id: 'synthetic-media-id',
            location: {
              id: 'synthetic-location-id',
              address_json: '{invalid-synthetic-json',
            },
          },
        },
      })
    );
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.violations[0]?.category).toBe('embedded-json');
  });

  it('is deterministic and idempotent and does not consult capture environment values', () => {
    const beforeEnvironment = sanitizeBatch(oneFile('shortcode-video.json', shortcodeVideo()));
    process.env.IG_PROFILE_USERNAME = 'synthetic-unrelated-environment-value';
    const afterEnvironment = sanitizeBatch(oneFile('shortcode-video.json', shortcodeVideo()));
    delete process.env.IG_PROFILE_USERNAME;
    expect(beforeEnvironment.ok).toBe(true);
    expect(afterEnvironment.ok).toBe(true);
    if (!beforeEnvironment.ok || !afterEnvironment.ok) return;
    expect(JSON.stringify([...afterEnvironment.files])).toBe(
      JSON.stringify([...beforeEnvironment.files])
    );
    const secondPass = sanitizeBatch(beforeEnvironment.files);
    expect(secondPass.ok).toBe(true);
    if (secondPass.ok) {
      expect(JSON.stringify([...secondPass.files])).toBe(
        JSON.stringify([...beforeEnvironment.files])
      );
    }
  });
});

describe('IG fixture sanitizer entity correlation', () => {
  it('joins aliases, numeric representations, transitive username links, and cross-file records', () => {
    const firstId = entityLeaf({
      filename: 'story.json',
      path: ['records', 0, 'id'],
      normalizedPath: 'records[].id',
      value: 73001,
      entity: 'PERSON',
      recordPath: 'records[]',
      role: 'ID',
      namespace: 'PERSON_IG',
    });
    const firstUsername = entityLeaf({
      filename: 'story.json',
      path: ['records', 0, 'username'],
      normalizedPath: 'records[].username',
      value: 'synthetic_bridge',
      entity: 'PERSON',
      recordPath: 'records[]',
      role: 'USERNAME',
      namespace: 'PERSON_USERNAME',
    });
    const crossFileId = entityLeaf({
      filename: 'web-profile-info.json',
      path: ['users', 0, 'pk'],
      normalizedPath: 'users[].pk',
      value: '73001',
      entity: 'PERSON',
      recordPath: 'users[]',
      role: 'ID',
      namespace: 'PERSON_IG',
    });
    const crossFileUsername = entityLeaf({
      filename: 'web-profile-info.json',
      path: ['users', 1, 'username'],
      normalizedPath: 'users[].username',
      value: 'synthetic_bridge',
      entity: 'PERSON',
      recordPath: 'users[]',
      role: 'USERNAME',
      namespace: 'PERSON_USERNAME',
    });
    const leaves = [firstId, firstUsername, crossFileId, crossFileUsername];
    expect(referenceFor(firstId, leaves)).toEqual(referenceFor(crossFileUsername, leaves));
  });

  it('does not merge identical names, URL-similar records, or different identifier namespaces', () => {
    const fullNameA = entityLeaf({
      filename: 'story.json',
      path: ['people', 0, 'full_name'],
      normalizedPath: 'people[].full_name',
      value: 'Shared Synthetic Name',
      entity: 'PERSON',
      recordPath: 'people[]',
      role: 'FULL_NAME',
    });
    const fullNameB = entityLeaf({
      filename: 'story.json',
      path: ['people', 1, 'full_name'],
      normalizedPath: 'people[].full_name',
      value: 'Shared Synthetic Name',
      entity: 'PERSON',
      recordPath: 'people[]',
      role: 'FULL_NAME',
    });
    const instagramId = entityLeaf({
      filename: 'story.json',
      path: ['people', 2, 'id'],
      normalizedPath: 'people[].id',
      value: '73001',
      entity: 'PERSON',
      recordPath: 'people[]',
      role: 'ID',
      namespace: 'PERSON_IG',
    });
    const facebookId = entityLeaf({
      filename: 'story.json',
      path: ['people', 3, 'fbid'],
      normalizedPath: 'people[].fbid',
      value: '73001',
      entity: 'PERSON',
      recordPath: 'people[]',
      role: 'FB_ID',
      namespace: 'PERSON_FB',
    });
    const avatarA = entityUrlLeaf(
      'story.json',
      ['people', 4, 'profile_pic_url'],
      'people[].profile_pic_url',
      'people[]',
      'https://avatar.synthetic.example/shared/path?signature=one'
    );
    const avatarB = entityUrlLeaf(
      'story.json',
      ['people', 5, 'profile_pic_url'],
      'people[].profile_pic_url',
      'people[]',
      'https://avatar.synthetic.example/shared/path?signature=two'
    );
    const leaves = [fullNameA, fullNameB, instagramId, facebookId, avatarA, avatarB];
    expect(referenceFor(fullNameA, leaves)).not.toEqual(referenceFor(fullNameB, leaves));
    expect(referenceFor(instagramId, leaves)).not.toEqual(referenceFor(facebookId, leaves));
    expect(referenceFor(avatarA, leaves)).not.toEqual(referenceFor(avatarB, leaves));
  });

  it('links media fields by containment and exact media identifiers', () => {
    const containedId = entityLeaf({
      filename: 'shortcode-sidecar.json',
      path: ['children', 0, 'id'],
      normalizedPath: 'children[].id',
      value: 'media-73001',
      entity: 'MEDIA',
      recordPath: 'children[]',
      role: 'ID',
      namespace: 'MEDIA_ID',
    });
    const containedShortcode = entityLeaf({
      filename: 'shortcode-sidecar.json',
      path: ['children', 0, 'shortcode'],
      normalizedPath: 'children[].shortcode',
      value: 'synthetic-media-code',
      entity: 'MEDIA',
      recordPath: 'children[]',
      role: 'SHORTCODE',
      namespace: 'MEDIA_SHORTCODE',
    });
    const containedUploadId = entityLeaf({
      filename: 'shortcode-sidecar.json',
      path: ['children', 0, 'upload_id'],
      normalizedPath: 'children[].upload_id',
      value: 'upload-84001',
      entity: 'MEDIA',
      recordPath: 'children[]',
      role: 'UPLOAD_ID',
      namespace: 'MEDIA_UPLOAD_ID',
    });
    const crossFileId = entityLeaf({
      filename: 'shortcode-video.json',
      path: ['media', 'id'],
      normalizedPath: 'media.id',
      value: 'media-73001',
      entity: 'MEDIA',
      recordPath: 'media',
      role: 'ID',
      namespace: 'MEDIA_ID',
    });
    const leaves = [containedId, containedShortcode, containedUploadId, crossFileId];
    expect(referenceFor(containedId, leaves)).toEqual(referenceFor(containedShortcode, leaves));
    expect(referenceFor(containedId, leaves)).toEqual(referenceFor(containedUploadId, leaves));
    expect(referenceFor(containedId, leaves)).toEqual(referenceFor(crossFileId, leaves));
  });

  it('rejects contradictory strong identifiers in one entity record', () => {
    const first = entityLeaf({
      filename: 'story.json',
      path: ['people', 0, 'id'],
      normalizedPath: 'people[].id',
      value: 'person-73001',
      entity: 'PERSON',
      recordPath: 'people[]',
      role: 'ID',
      namespace: 'PERSON_IG',
    });
    const conflicting = entityLeaf({
      filename: 'story.json',
      path: ['people', 0, 'pk'],
      normalizedPath: 'people[].pk',
      value: 'person-73002',
      entity: 'PERSON',
      recordPath: 'people[]',
      role: 'ID',
      namespace: 'PERSON_IG',
    });
    const result = discoverEntities([first, conflicting]);
    expect(result.index).toBeUndefined();
    expect(result.violations[0]?.category).toBe('entity-contradiction');
  });

  it('keeps profile-picture media identity separate from person identity', () => {
    const personId = entityLeaf({
      filename: 'highlights-tray.json',
      path: ['tray', 0, 'user', 'id'],
      normalizedPath: 'tray[].user.id',
      value: '73001',
      entity: 'PERSON',
      recordPath: 'tray[].user',
      role: 'ID',
      namespace: 'PERSON_IG',
    });
    const profileMedia = entityLeaf({
      filename: 'highlights-tray.json',
      path: ['tray', 0, 'user', 'profile_pic_id'],
      normalizedPath: 'tray[].user.profile_pic_id',
      value: '73001',
      entity: 'MEDIA',
      recordPath: 'tray[].user',
      role: 'PROFILE_PICTURE_ID',
      namespace: 'MEDIA_ID',
    });
    const leaves = [personId, profileMedia];
    expect(referenceFor(personId, leaves)?.kind).toBe('PERSON');
    expect(referenceFor(profileMedia, leaves)?.kind).toBe('MEDIA');
  });
});

describe('committed sanitized fixture audit', () => {
  it('classifies every committed path, is idempotent, and contains only synthetic URLs', async () => {
    const files = new Map<FixtureFilename, JsonValue>();
    for (const filename of FIXTURE_FILENAMES) {
      const text = await readFile(
        join(import.meta.dirname, 'effect', '__fixtures__', filename),
        'utf8'
      );
      const parsed: unknown = JSON.parse(text);
      expect(isJsonValue(parsed)).toBe(true);
      if (isJsonValue(parsed)) files.set(filename, parsed);
    }
    const result = sanitizeBatch(files);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify([...result.files])).toBe(JSON.stringify([...files]));
    for (const value of result.files.values()) {
      const urls = allStrings(value).filter(text => /^https?:\/\//.test(text));
      expect(urls.every(text => new URL(text).hostname === 'sanitized.invalid')).toBe(true);
    }
  });
});
