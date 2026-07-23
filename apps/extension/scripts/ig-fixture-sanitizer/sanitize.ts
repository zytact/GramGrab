import {
  discoverEntities,
  entityForLeaf,
  entityRecordKey,
  formatActualPath,
  type ActualPath,
  type ClassifiedLeaf,
  type EntityIndex,
  type JsonObject,
  type JsonPrimitive,
  type JsonValue,
} from './entities.ts';
import {
  FIXTURE_FILENAMES,
  FIXTURE_POLICIES,
  type EntityKind,
  type FixtureFilename,
  type FixturePolicy,
  type PolicyAction,
  type PolicyRule,
  type PrimitiveType,
} from './policy.ts';

export interface SanitizerViolation {
  readonly filename: FixtureFilename;
  readonly path: string;
  readonly expected: string;
  readonly observed: string;
  readonly category:
    | 'embedded-json'
    | 'entity-contradiction'
    | 'invariant'
    | 'type'
    | 'unknown-path';
}

export type SanitizationResult =
  | {
      readonly ok: true;
      readonly files: ReadonlyMap<FixtureFilename, JsonValue>;
      readonly leaves: ReadonlyArray<ClassifiedLeaf>;
    }
  | { readonly ok: false; readonly violations: ReadonlyArray<SanitizerViolation> };

const normalizedPath = (path: ActualPath): string =>
  path.reduce<string>(
    (result, part) =>
      typeof part === 'number' ? `${result}[]` : result.length === 0 ? part : `${result}.${part}`,
    ''
  );

const observedType = (value: unknown): string => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
};

const primitiveType = (value: JsonPrimitive): PrimitiveType | 'null' => {
  if (value === null) return 'null';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  return 'boolean';
};

export const isJsonValue = (value: unknown): value is JsonValue => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== 'object') return false;
  return Object.values(value).every(isJsonValue);
};

const isJsonObject = (value: JsonValue): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const ruleMap = (policy: FixturePolicy): ReadonlyMap<string, PolicyRule> =>
  new Map(policy.rules.map(rule => [rule.path, rule]));

const inferredContainerType = (
  candidatePaths: ReadonlyArray<string>,
  path: string
): 'array' | 'object' | undefined => {
  if (candidatePaths.some(candidate => candidate.startsWith(`${path}[]`))) return 'array';
  if (candidatePaths.some(candidate => candidate.startsWith(`${path}.`))) return 'object';
  return undefined;
};

const expectedContainerType = (
  policy: FixturePolicy,
  path: string
): 'array' | 'object' | undefined => {
  if (path.length === 0) return 'object';
  const exact = policy.emptyContainers?.find(container => container.path === path);
  if (exact) return exact.type;
  const ruleType = inferredContainerType(
    policy.rules.map(rule => rule.path),
    path
  );
  if (ruleType) return ruleType;
  return inferredContainerType(
    policy.emptyContainers?.map(container => container.path) ?? [],
    path
  );
};

interface ValidationContext {
  readonly filename: FixtureFilename;
  readonly policy: FixturePolicy;
  readonly rules: ReadonlyMap<string, PolicyRule>;
  readonly leaves: Array<ClassifiedLeaf>;
  readonly violations: Array<SanitizerViolation>;
}

const validateContainer = (
  normalized: string,
  observed: 'array' | 'object',
  context: ValidationContext
): boolean => {
  const exactRule = context.rules.get(normalized);
  if (exactRule) {
    context.violations.push({
      filename: context.filename,
      path: normalized,
      expected: exactRule.types.join('|'),
      observed,
      category: 'type',
    });
    return true;
  }
  const expected = expectedContainerType(context.policy, normalized);
  if (expected === observed) return true;
  context.violations.push({
    filename: context.filename,
    path: normalized,
    expected: expected ?? 'reviewed path',
    observed,
    category: expected ? 'type' : 'unknown-path',
  });
  return false;
};

const validatePrimitive = (
  value: JsonPrimitive,
  path: ActualPath,
  normalized: string,
  context: ValidationContext
): void => {
  const rule = context.rules.get(normalized);
  if (!rule) {
    if (value === null && expectedContainerType(context.policy, normalized)) return;
    context.violations.push({
      filename: context.filename,
      path: normalized,
      expected: 'reviewed path',
      observed: primitiveType(value),
      category: 'unknown-path',
    });
    return;
  }

  const type = primitiveType(value);
  if (type !== 'null' && !rule.types.some(expected => expected === type)) {
    context.violations.push({
      filename: context.filename,
      path: normalized,
      expected: rule.types.join('|'),
      observed: type,
      category: 'type',
    });
    return;
  }
  context.leaves.push({
    filename: context.filename,
    path,
    normalizedPath: normalized,
    value,
    rule,
  });
};

const validateValue = (value: JsonValue, path: ActualPath, context: ValidationContext): void => {
  const normalized = normalizedPath(path);
  if (Array.isArray(value)) {
    if (!validateContainer(normalized, 'array', context)) return;
    value.forEach((item, index) => validateValue(item, [...path, index], context));
    return;
  }
  if (isJsonObject(value)) {
    if (!validateContainer(normalized, 'object', context)) return;
    for (const [key, child] of Object.entries(value)) {
      validateValue(child, [...path, key], context);
    }
    return;
  }
  validatePrimitive(value, path, normalized, context);
};

const validateBatchPolicy = (
  files: ReadonlyMap<FixtureFilename, JsonValue>
): {
  readonly leaves: ReadonlyArray<ClassifiedLeaf>;
  readonly violations: ReadonlyArray<SanitizerViolation>;
} => {
  const leaves: Array<ClassifiedLeaf> = [];
  const violations: Array<SanitizerViolation> = [];
  for (const filename of FIXTURE_FILENAMES) {
    const value = files.get(filename);
    if (value === undefined) continue;
    const policy = FIXTURE_POLICIES[filename];
    validateValue(value, [], {
      filename,
      policy,
      rules: ruleMap(policy),
      leaves,
      violations,
    });
  }
  return { leaves, violations };
};

const roleToken = (role: string): string => role.replaceAll('-', '_').toUpperCase();
const urlRole = (role: string): string => role.replaceAll('_', '-').toLowerCase();

const sentinelBase = (kind: EntityKind): number => {
  switch (kind) {
    case 'PERSON':
      return -1_000_000;
    case 'MEDIA':
      return -2_000_000;
    case 'LOCATION':
      return -3_000_000;
    case 'AUDIO':
      return -4_000_000;
  }
};

const opaquePlaceholder = (value: string, category: string): boolean =>
  new RegExp(`^SANITIZED_${roleToken(category)}_[1-9][0-9]*$`).test(value);

const entityReplacement = (
  value: string | number,
  entity: { readonly kind: EntityKind; readonly number: number },
  role: string
): string | number => {
  if (typeof value === 'string') {
    return `SANITIZED_${entity.kind}_${entity.number}_${roleToken(role)}`;
  }
  return sentinelBase(entity.kind) - entity.number;
};

const safeUrl = (
  entity: { readonly kind: EntityKind; readonly number: number },
  role: string
): string =>
  `https://sanitized.invalid/${entity.kind.toLowerCase()}/${entity.number}/${urlRole(role)}`;

const isSafeUrl = (value: string, role?: string): boolean => {
  try {
    const parsed = new URL(value);
    const pathPattern = /^\/(?:person|media|location|audio|resource)\/[1-9][0-9]*\/[a-z0-9-]+$/;
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === 'sanitized.invalid' &&
      parsed.search === '' &&
      parsed.hash === '' &&
      pathPattern.test(parsed.pathname) &&
      (role === undefined || parsed.pathname.endsWith(`/${urlRole(role)}`))
    );
  } catch {
    return false;
  }
};

interface ReplacementState {
  readonly opaqueNumbers: ReadonlyMap<string, number>;
  readonly urlNumbers: ReadonlyMap<string, number>;
}

const assignNumber = (
  values: Map<string, number>,
  counts: Map<string, number>,
  category: string,
  value: string
): void => {
  const key = `${category}|${value}`;
  if (values.has(key)) return;
  const number = (counts.get(category) ?? 0) + 1;
  counts.set(category, number);
  values.set(key, number);
};

const indexOpaqueLeaf = (
  leaf: ClassifiedLeaf,
  numbers: Map<string, number>,
  counts: Map<string, number>
): void => {
  const action = leaf.rule.action;
  if (action.tag !== 'opaque' || typeof leaf.value !== 'string' || leaf.value === '') return;
  if (!opaquePlaceholder(leaf.value, action.category)) {
    assignNumber(numbers, counts, action.category, leaf.value);
  }
};

const indexUrlLeaf = (
  leaf: ClassifiedLeaf,
  numbers: Map<string, number>,
  counts: Map<string, number>
): void => {
  const action = leaf.rule.action;
  if (
    action.tag !== 'url' ||
    action.entity ||
    typeof leaf.value !== 'string' ||
    leaf.value === ''
  ) {
    return;
  }
  if (!isSafeUrl(leaf.value, action.role)) {
    assignNumber(numbers, counts, action.role, leaf.value);
  }
};

const replacementState = (leaves: ReadonlyArray<ClassifiedLeaf>): ReplacementState => {
  const opaqueNumbers = new Map<string, number>();
  const urlNumbers = new Map<string, number>();
  const opaqueCounts = new Map<string, number>();
  const urlCounts = new Map<string, number>();
  for (const leaf of leaves) {
    indexOpaqueLeaf(leaf, opaqueNumbers, opaqueCounts);
    indexUrlLeaf(leaf, urlNumbers, urlCounts);
  }
  return { opaqueNumbers, urlNumbers };
};

type ReplacementOutcome = {
  readonly value?: JsonPrimitive;
  readonly violation?: SanitizerViolation;
};

const embeddedViolation = (
  leaf: ClassifiedLeaf,
  suffix: string,
  expected: string,
  observed: string
): ReplacementOutcome => ({
  violation: {
    filename: leaf.filename,
    path: `${leaf.normalizedPath}${suffix}`,
    expected,
    observed,
    category: 'embedded-json',
  },
});

const parseEmbeddedAddress = (
  leaf: ClassifiedLeaf,
  value: string
): { readonly parsed?: JsonObject; readonly violation?: SanitizerViolation } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return embeddedViolation(leaf, '', 'valid reviewed address JSON', 'invalid JSON');
  }
  if (!isJsonValue(parsed) || !isJsonObject(parsed)) {
    return embeddedViolation(leaf, '', 'reviewed address object', observedType(parsed));
  }
  return { parsed };
};

const ADDRESS_KEYS = new Set([
  'city_name',
  'country_code',
  'exact_city_match',
  'exact_country_match',
  'exact_region_match',
  'region_name',
  'street_address',
  'zip_code',
]);

const replaceAddressFields = (
  leaf: ClassifiedLeaf,
  parsed: JsonObject,
  locationNumber: number
): ReplacementOutcome => {
  const output: Record<string, JsonValue> = {};
  for (const [key, nested] of Object.entries(parsed)) {
    if (!ADDRESS_KEYS.has(key)) {
      return embeddedViolation(leaf, `.${key}`, 'reviewed embedded path', observedType(nested));
    }
    if (nested === null || nested === '' || typeof nested === 'boolean') {
      output[key] = nested;
      continue;
    }
    if (typeof nested !== 'string') {
      return embeddedViolation(leaf, `.${key}`, 'string|boolean|null', observedType(nested));
    }
    output[key] = `SANITIZED_LOCATION_${locationNumber}_${roleToken(key)}`;
  }
  return { value: JSON.stringify(output) };
};

const embeddedAddressReplacement = (
  leaf: ClassifiedLeaf,
  value: string,
  entities: EntityIndex
): ReplacementOutcome => {
  const decoded = parseEmbeddedAddress(leaf, value);
  if (!decoded.parsed) return decoded;
  const locationAnchor = leaf.path.slice(0, -1);
  const location = entities.byRecord.get(
    entityRecordKey('LOCATION', leaf.filename, locationAnchor)
  );
  if (!location) {
    return embeddedViolation(leaf, '', 'correlated location entity', 'missing entity');
  }
  return replaceAddressFields(leaf, decoded.parsed, location.number);
};

const replacementFailure = (leaf: ClassifiedLeaf, expected: string): ReplacementOutcome => ({
  violation: {
    filename: leaf.filename,
    path: leaf.normalizedPath,
    expected,
    observed: primitiveType(leaf.value),
    category: 'invariant',
  },
});

const replaceEntityField = (
  leaf: ClassifiedLeaf,
  entities: EntityIndex,
  entityKind: EntityKind,
  role: string
): ReplacementOutcome => {
  const entity = entityForLeaf(leaf, entities);
  const value = leaf.value;
  if (!entity || (typeof value !== 'string' && typeof value !== 'number')) {
    return replacementFailure(leaf, `${entityKind} entity`);
  }
  return { value: entityReplacement(value, entity, role) };
};

const replaceUrl = (
  leaf: ClassifiedLeaf,
  entities: EntityIndex,
  state: ReplacementState,
  role: string
): ReplacementOutcome => {
  const value = leaf.value;
  if (typeof value !== 'string') return replacementFailure(leaf, 'url');
  const entity = entityForLeaf(leaf, entities);
  if (entity) return { value: safeUrl(entity, role) };
  if (isSafeUrl(value, role)) return { value };
  const number = state.urlNumbers.get(`${role}|${value}`);
  return number
    ? { value: `https://sanitized.invalid/resource/${number}/${urlRole(role)}` }
    : replacementFailure(leaf, 'url');
};

const replaceOpaque = (
  leaf: ClassifiedLeaf,
  state: ReplacementState,
  category: string
): ReplacementOutcome => {
  const value = leaf.value;
  if (typeof value !== 'string') return replacementFailure(leaf, 'opaque');
  if (opaquePlaceholder(value, category)) return { value };
  const number = state.opaqueNumbers.get(`${category}|${value}`);
  return number
    ? { value: `SANITIZED_${roleToken(category)}_${number}` }
    : replacementFailure(leaf, 'opaque');
};

const replaceLeaf = (
  leaf: ClassifiedLeaf,
  entities: EntityIndex,
  state: ReplacementState
): ReplacementOutcome => {
  const value = leaf.value;
  const action: PolicyAction = leaf.rule.action;
  if (value === null || value === '') return { value };
  switch (action.tag) {
    case 'preserve':
      return { value };
    case 'entityField':
      return replaceEntityField(leaf, entities, action.entity, action.role);
    case 'url':
      return replaceUrl(leaf, entities, state, action.role);
    case 'opaque':
      return replaceOpaque(leaf, state, action.category);
    case 'embeddedAddressJson':
      return typeof value === 'string'
        ? embeddedAddressReplacement(leaf, value, entities)
        : replacementFailure(leaf, action.tag);
  }
};

const transformValue = (
  filename: FixtureFilename,
  value: JsonValue,
  path: ActualPath,
  leaves: ReadonlyMap<string, ClassifiedLeaf>,
  replacements: ReadonlyMap<string, JsonPrimitive>
): JsonValue => {
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      transformValue(filename, item, [...path, index], leaves, replacements)
    );
  }
  if (isJsonObject(value)) {
    const output: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      output[key] = transformValue(filename, child, [...path, key], leaves, replacements);
    }
    return output;
  }
  const key = `${filename}|${formatActualPath(path)}`;
  return leaves.has(key) ? (replacements.get(key) ?? value) : value;
};

const getAtPath = (value: JsonValue, path: ActualPath): JsonValue | undefined => {
  let current: JsonValue | undefined = value;
  for (const part of path) {
    if (current === undefined || current === null) return undefined;
    if (typeof part === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[part];
    } else {
      if (!isJsonObject(current)) return undefined;
      current = current[part];
    }
  }
  return current;
};

const sameArrayStructure = (raw: Array<JsonValue>, sanitized: Array<JsonValue>): boolean => {
  if (raw.length !== sanitized.length) return false;
  return raw.every((item, index) => {
    const candidate = sanitized[index];
    return candidate !== undefined && sameStructure(item, candidate);
  });
};

const sameObjectStructure = (raw: JsonObject, sanitized: JsonObject): boolean => {
  const rawKeys = Object.keys(raw);
  const sanitizedKeys = Object.keys(sanitized);
  if (rawKeys.length !== sanitizedKeys.length) return false;
  if (rawKeys.some((key, index) => key !== sanitizedKeys[index])) return false;
  return rawKeys.every(key => {
    const rawChild = raw[key];
    const sanitizedChild = sanitized[key];
    if (rawChild === undefined || sanitizedChild === undefined) return false;
    return sameStructure(rawChild, sanitizedChild);
  });
};

function sameStructure(raw: JsonValue, sanitized: JsonValue): boolean {
  if (raw === null) return sanitized === null;
  if (sanitized === null) return false;
  if (Array.isArray(raw)) {
    return Array.isArray(sanitized) ? sameArrayStructure(raw, sanitized) : false;
  }
  if (Array.isArray(sanitized)) return false;
  if (isJsonObject(raw)) {
    return isJsonObject(sanitized) ? sameObjectStructure(raw, sanitized) : false;
  }
  if (isJsonObject(sanitized)) return false;
  return typeof raw === typeof sanitized;
}

const validUrlReplacement = (
  sanitized: JsonValue,
  expected: JsonPrimitive | undefined,
  role: string
): boolean => {
  if (sanitized !== expected || typeof sanitized !== 'string') return false;
  return isSafeUrl(sanitized, role);
};

const validOpaqueReplacement = (
  sanitized: JsonValue,
  expected: JsonPrimitive | undefined,
  category: string
): boolean => {
  if (sanitized !== expected || typeof sanitized !== 'string') return false;
  return opaquePlaceholder(sanitized, category);
};

const validEmbeddedReplacement = (
  sanitized: JsonValue,
  expected: JsonPrimitive | undefined
): boolean => {
  if (sanitized !== expected || typeof sanitized !== 'string') return false;
  try {
    const parsed: unknown = JSON.parse(sanitized);
    if (!isJsonValue(parsed) || !isJsonObject(parsed)) return false;
    return Object.entries(parsed).every(([key, value]) => {
      if (!ADDRESS_KEYS.has(key)) return false;
      if (value === null || value === '' || typeof value === 'boolean') return true;
      const role = roleToken(key);
      return (
        typeof value === 'string' &&
        new RegExp(`^SANITIZED_LOCATION_[1-9][0-9]*_${role}$`).test(value)
      );
    });
  } catch {
    return false;
  }
};

const verifyLeaf = (
  leaf: ClassifiedLeaf,
  sanitized: JsonValue | undefined,
  expectedReplacement: JsonPrimitive | undefined
): boolean => {
  if (sanitized === undefined) return false;
  if (leaf.value === null || leaf.value === '') return sanitized === leaf.value;
  const action = leaf.rule.action;
  switch (action.tag) {
    case 'preserve':
      return sanitized === leaf.value;
    case 'entityField':
      return sanitized === expectedReplacement;
    case 'url':
      return validUrlReplacement(sanitized, expectedReplacement, action.role);
    case 'opaque':
      return validOpaqueReplacement(sanitized, expectedReplacement, action.category);
    case 'embeddedAddressJson':
      return validEmbeddedReplacement(sanitized, expectedReplacement);
  }
};

interface ReplacementPlan {
  readonly leaves: ReadonlyMap<string, ClassifiedLeaf>;
  readonly replacements: ReadonlyMap<string, JsonPrimitive>;
  readonly violations: ReadonlyArray<SanitizerViolation>;
}

const buildReplacementPlan = (
  classifiedLeaves: ReadonlyArray<ClassifiedLeaf>,
  entities: EntityIndex
): ReplacementPlan => {
  const state = replacementState(classifiedLeaves);
  const leaves = new Map<string, ClassifiedLeaf>();
  const replacements = new Map<string, JsonPrimitive>();
  const violations: Array<SanitizerViolation> = [];
  for (const leaf of classifiedLeaves) {
    const key = `${leaf.filename}|${formatActualPath(leaf.path)}`;
    leaves.set(key, leaf);
    const replacement = replaceLeaf(leaf, entities, state);
    if (replacement.violation) violations.push(replacement.violation);
    else if (replacement.value !== undefined) replacements.set(key, replacement.value);
  }
  return { leaves, replacements, violations };
};

const transformFiles = (
  files: ReadonlyMap<FixtureFilename, JsonValue>,
  plan: ReplacementPlan,
  violations: Array<SanitizerViolation>
): ReadonlyMap<FixtureFilename, JsonValue> => {
  const sanitizedFiles = new Map<FixtureFilename, JsonValue>();
  for (const filename of FIXTURE_FILENAMES) {
    const raw = files.get(filename);
    if (raw === undefined) continue;
    const sanitized = transformValue(filename, raw, [], plan.leaves, plan.replacements);
    if (!sameStructure(raw, sanitized)) {
      violations.push({
        filename,
        path: '',
        expected: 'identical structure and primitive types',
        observed: 'postcondition mismatch',
        category: 'invariant',
      });
    }
    sanitizedFiles.set(filename, sanitized);
  }
  return sanitizedFiles;
};

const verifyFiles = (
  classifiedLeaves: ReadonlyArray<ClassifiedLeaf>,
  sanitizedFiles: ReadonlyMap<FixtureFilename, JsonValue>,
  replacements: ReadonlyMap<string, JsonPrimitive>
): ReadonlyArray<SanitizerViolation> => {
  const violations: Array<SanitizerViolation> = [];
  for (const leaf of classifiedLeaves) {
    const sanitized = sanitizedFiles.get(leaf.filename);
    const key = `${leaf.filename}|${formatActualPath(leaf.path)}`;
    const candidate = sanitized ? getAtPath(sanitized, leaf.path) : undefined;
    if (verifyLeaf(leaf, candidate, replacements.get(key))) continue;
    violations.push({
      filename: leaf.filename,
      path: leaf.normalizedPath,
      expected: leaf.rule.action.tag,
      observed: 'postcondition mismatch',
      category: 'invariant',
    });
  }
  return violations;
};

export const sanitizeBatch = (
  files: ReadonlyMap<FixtureFilename, JsonValue>
): SanitizationResult => {
  const policy = validateBatchPolicy(files);
  if (policy.violations.length > 0) return { ok: false, violations: policy.violations };

  const entities = discoverEntities(policy.leaves);
  if (!entities.index) return { ok: false, violations: entities.violations };

  const plan = buildReplacementPlan(policy.leaves, entities.index);
  if (plan.violations.length > 0) return { ok: false, violations: plan.violations };
  const violations: Array<SanitizerViolation> = [];
  const sanitizedFiles = transformFiles(files, plan, violations);
  violations.push(...verifyFiles(policy.leaves, sanitizedFiles, plan.replacements));
  if (violations.length > 0) return { ok: false, violations };
  return { ok: true, files: sanitizedFiles, leaves: policy.leaves };
};
