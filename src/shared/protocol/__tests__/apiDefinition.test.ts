import { describe, it, expect } from 'vitest';
import {
  apiKeyOptional,
  hasUsableApiDefinition,
  isConfiguredApiDefinition,
} from '../apiDefinition';
import type { APIDefinition } from '../types';

describe('apiKeyOptional', () => {
  it('is true for local providers', () => {
    expect(apiKeyOptional({ isLocal: true, apiType: 'chatgpt' })).toBe(true);
  });

  it('is true for claude-agent regardless of isLocal', () => {
    expect(apiKeyOptional({ apiType: 'claude-agent' })).toBe(true);
    expect(apiKeyOptional({ isLocal: false, apiType: 'claude-agent' })).toBe(true);
  });

  it('is false for remote providers without the local flag', () => {
    expect(apiKeyOptional({ apiType: 'anthropic' })).toBe(false);
    expect(apiKeyOptional({ isLocal: false, apiType: 'responses_api' })).toBe(false);
  });
});

describe('hasUsableApiDefinition', () => {
  it('is false for an empty list and for keyless remote definitions', () => {
    expect(hasUsableApiDefinition([])).toBe(false);
    expect(
      hasUsableApiDefinition([
        { apiType: 'anthropic', apiKey: '' },
        { apiType: 'responses_api', apiKey: '   ' },
      ])
    ).toBe(false);
  });

  it('is true once any definition holds a key or needs none', () => {
    expect(
      hasUsableApiDefinition([
        { apiType: 'anthropic', apiKey: '' },
        { apiType: 'google', apiKey: 'k' },
      ])
    ).toBe(true);
    expect(hasUsableApiDefinition([{ apiType: 'chatgpt', apiKey: '', isLocal: true }])).toBe(true);
  });
});

describe('isConfiguredApiDefinition', () => {
  const factoryDefault = (overrides: Partial<APIDefinition> = {}): APIDefinition =>
    ({
      id: 'api_default_chatgpt_test',
      apiType: 'chatgpt',
      name: 'Test',
      baseUrl: '',
      apiKey: '',
      isDefault: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    }) as APIDefinition;

  it('is false for an untouched factory default', () => {
    expect(isConfiguredApiDefinition(factoryDefault())).toBe(false);
  });

  it('treats the seeded xAI baseUrl as unconfigured', () => {
    expect(isConfiguredApiDefinition(factoryDefault({ baseUrl: 'https://api.x.ai/v1' }))).toBe(
      false
    );
  });

  it('is true with an API key', () => {
    expect(isConfiguredApiDefinition(factoryDefault({ apiKey: 'sk-x' }))).toBe(true);
  });

  it('is true with a custom baseUrl', () => {
    expect(isConfiguredApiDefinition(factoryDefault({ baseUrl: 'http://localhost:11434' }))).toBe(
      true
    );
  });

  it('is true for keyless configurations (isLocal, proxy, models endpoint, CLI overrides)', () => {
    expect(isConfiguredApiDefinition(factoryDefault({ isLocal: true }))).toBe(true);
    expect(isConfiguredApiDefinition(factoryDefault({ proxyUrl: 'https://proxy.example' }))).toBe(
      true
    );
    expect(isConfiguredApiDefinition(factoryDefault({ proxyAuthToken: 'shh' }))).toBe(true);
    expect(
      isConfiguredApiDefinition(factoryDefault({ modelsEndpoint: 'https://models.example' }))
    ).toBe(true);
    expect(isConfiguredApiDefinition(factoryDefault({ modelsEndpointDisabled: true }))).toBe(true);
    expect(isConfiguredApiDefinition(factoryDefault({ binaryPath: '/usr/bin/claude' }))).toBe(true);
    expect(isConfiguredApiDefinition(factoryDefault({ extraArgs: '--strict-mcp-config' }))).toBe(
      true
    );
  });

  it('is true with extra model ids, custom icon, or any advanced setting', () => {
    expect(isConfiguredApiDefinition(factoryDefault({ extraModelIds: ['my-model'] }))).toBe(true);
    expect(isConfiguredApiDefinition(factoryDefault({ extraModelIds: [] }))).toBe(false);
    expect(isConfiguredApiDefinition(factoryDefault({ icon: '🤖' }))).toBe(true);
    expect(
      isConfiguredApiDefinition(factoryDefault({ advancedSettings: { pruneThinking: false } }))
    ).toBe(true);
    expect(isConfiguredApiDefinition(factoryDefault({ advancedSettings: {} }))).toBe(false);
  });
});
