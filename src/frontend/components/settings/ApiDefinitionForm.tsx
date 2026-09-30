import { useReducer, useState, type ReactNode } from 'react';
import Spinner from '../ui/Spinner';
import { useAppActions } from '../../hooks/useApp';
import { useAlert } from '../../hooks/useAlert';
import type { APIDefinition, APIType, ReasoningDialect } from '../../../shared/protocol/types';
import { generateUniqueId } from '../../../shared/protocol/idGenerator';
import { apiKeyOptional } from '../../../shared/protocol/apiDefinition';
import {
  getApiTypeDisplayName,
  getApiTypeDefaultIcon,
  getApiDefinitionIcon,
} from '../../lib/apiTypeUtils';
import ChatgptSignInPanel from './ChatgptSignInPanel';
import {
  EMPTY_API_DEFINITION_FORM,
  apiDefinitionToForm,
  buildAdvancedSettings,
  effectiveReasoningDialect,
  formToApiDefinition,
  hidesProviderFields,
  showsProxyFields,
  typeSpecificAdvancedFields,
  type ApiDefinitionFormState,
} from './apiDefinitionFormState';

type FormPatch = Partial<ApiDefinitionFormState>;

const API_TYPE_CHOICES: { id: APIType; name: string; icon: string }[] = [
  { id: 'responses_api', name: 'OpenAI - Responses (new)', icon: '⚡' },
  { id: 'chatgpt', name: 'OpenAI - Chat Completions', icon: '💬' },
  { id: 'anthropic', name: 'Anthropic', icon: '✨' },
  { id: 'bedrock', name: 'AWS Bedrock', icon: '☁️' },
  { id: 'google', name: 'Google Gemini', icon: '💎' },
  { id: 'claude-agent', name: 'Claude Agent (subscription)', icon: '🅒' },
  { id: 'chatgpt-subscription', name: 'ChatGPT (subscription)', icon: '🅖' },
];

const REASONING_DIALECT_OPTIONS: { value: ReasoningDialect; label: string; hint: string }[] = [
  {
    value: 'openai',
    label: 'OpenAI — reasoning_effort',
    hint: 'The standard field. OpenAI, xAI, Kimi K3.',
  },
  {
    value: 'thinking-object',
    label: 'DeepSeek-style — thinking: {type}',
    hint: 'Sends {thinking: {type: enabled/disabled}}. DeepSeek, GLM, MiMo, Doubao.',
  },
  {
    value: 'enable-thinking',
    label: 'Qwen-style — enable_thinking',
    hint: 'Sends enable_thinking: true/false, always alone. Qwen/DashScope, Kimi K2.x.',
  },
  {
    value: 'openrouter',
    label: 'OpenRouter — reasoning: {…}',
    hint: "Sends OpenRouter's unified reasoning object and feeds signed reasoning_details back on later turns, so Claude behind OpenRouter survives a tool loop.",
  },
];

const INPUT_CLASS =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-base focus:border-blue-500 focus:ring-2 focus:ring-blue-500';
const LABEL_CLASS = 'mb-1.5 block text-sm font-medium text-gray-700';
const SECONDARY_BUTTON_CLASS =
  'rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50';
const PRIMARY_BUTTON_CLASS =
  'flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-400';

// The reasoning wire shape differs per vendor and several of them reject a
// request carrying two of them, so this is a dropdown, not a stack of toggles.
function ReasoningDialectField(props: {
  /** From `typeSpecificAdvancedFields`; empty renders nothing. */
  dialects: readonly ReasoningDialect[];
  dialect: ReasoningDialect;
  override: boolean;
  onDialectChange: (value: ReasoningDialect) => void;
  onOverrideChange: (value: boolean) => void;
}) {
  if (props.dialects.length === 0) return null;

  const options = REASONING_DIALECT_OPTIONS.filter(o => props.dialects.includes(o.value));
  const selected = REASONING_DIALECT_OPTIONS.find(o => o.value === props.dialect);
  // OpenRouter normalizes every model it fronts, so its own shape always wins.
  const overrideImplied = props.dialect === 'openrouter';

  return (
    <>
      <label className={LABEL_CLASS}>Reasoning dialect</label>
      <select
        value={props.dialect}
        onChange={e => props.onDialectChange(e.target.value as ReasoningDialect)}
        className="mb-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none"
      >
        {options.map(option => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <p className="mb-2 text-xs text-gray-500">{selected?.hint}</p>

      <label className="mb-2 flex cursor-pointer items-center">
        <input
          type="checkbox"
          checked={overrideImplied || props.override}
          disabled={overrideImplied}
          onChange={e => props.onOverrideChange(e.target.checked)}
          className="mr-2 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-60"
        />
        <span className="text-sm text-gray-700">Override per-model dialect</span>
      </label>
      <p className="mb-3 ml-6 text-xs text-gray-500">
        {overrideImplied
          ? 'Always on for OpenRouter — it normalizes every model it serves, so a model’s own dialect never applies.'
          : 'Off: a known model’s own dialect wins and this is only the fallback for unrecognized ones. On: this dialect wins everywhere — for a gateway that re-shapes what it fronts.'}
      </p>
    </>
  );
}

// Custom model list knobs shared by the providers with a built-in list
// (claude-agent, chatgpt-subscription): extraModelIds appends to it,
// modelsEndpointDisabled replaces it.
function ModelListFields(props: {
  builtInListName: string;
  extraModelIds: string;
  modelListReplaced: boolean;
  onExtraModelIdsChange: (value: string) => void;
  onModelListReplacedChange: (value: boolean) => void;
}) {
  return (
    <>
      <label className={LABEL_CLASS}>Extra Model IDs (Optional)</label>
      <textarea
        className="mb-1 w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
        placeholder="one-model-id-per-line"
        rows={3}
        value={props.extraModelIds}
        onChange={e => props.onExtraModelIdsChange(e.target.value)}
      />
      <p className="mb-1 text-xs text-gray-500">
        Model IDs added to the {props.builtInListName} list (one per line)
      </p>
      <label className="mb-4 flex items-center gap-2 text-sm text-gray-600">
        <input
          type="checkbox"
          checked={props.modelListReplaced}
          onChange={e => props.onModelListReplacedChange(e.target.checked)}
          className="rounded border-gray-300"
        />
        Use only my model list (replace the {props.builtInListName} list)
      </label>
    </>
  );
}

// claude-agent's knobs: CLI overrides plus the custom model list.
function ClaudeAgentFields({
  form,
  patch,
}: {
  form: ApiDefinitionFormState;
  patch: (fields: FormPatch) => void;
}) {
  return (
    <>
      <label className={LABEL_CLASS}>Claude Binary Path (Optional)</label>
      <input
        type="text"
        className={`mb-1 ${INPUT_CLASS}`}
        placeholder="Bundled executable"
        value={form.binaryPath}
        onChange={e => patch({ binaryPath: e.target.value })}
      />
      <p className="mb-4 text-xs text-gray-500">
        Full path to a <code className="rounded bg-gray-100 px-1">claude</code> executable. Leave
        empty to use the SDK's bundled one.
      </p>
      <label className={LABEL_CLASS}>Extra CLI Args (Optional)</label>
      <input
        type="text"
        className="mb-1 w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
        placeholder="--strict-mcp-config --settings /path/to.json"
        value={form.extraArgs}
        onChange={e => patch({ extraArgs: e.target.value })}
      />
      <p className="mb-4 text-xs text-gray-500">
        Appended to the claude invocation. Only{' '}
        <code className="rounded bg-gray-100 px-1">--flag</code> /{' '}
        <code className="rounded bg-gray-100 px-1">--key value</code> /{' '}
        <code className="rounded bg-gray-100 px-1">--key=value</code> forms are supported.
      </p>
      <ModelListFields
        builtInListName="built-in claude-agent"
        extraModelIds={form.extraModelIds}
        modelListReplaced={form.modelsEndpointDisabled}
        onExtraModelIdsChange={value => patch({ extraModelIds: value })}
        onModelListReplacedChange={value => patch({ modelsEndpointDisabled: value })}
      />
    </>
  );
}

function FlagField(props: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  children: ReactNode;
}) {
  return (
    <>
      <label className="mb-2 flex cursor-pointer items-center">
        <input
          type="checkbox"
          checked={props.checked}
          onChange={e => props.onChange(e.target.checked)}
          className="mr-2 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
        />
        <span className="text-sm text-gray-700">{props.label}</span>
      </label>
      <p className="mb-3 ml-6 text-xs text-gray-500">{props.children}</p>
    </>
  );
}

function AdvancedFields({
  form,
  patch,
}: {
  form: ApiDefinitionFormState;
  patch: (fields: FormPatch) => void;
}) {
  const isChatgptSubscription = form.apiType === 'chatgpt-subscription';
  const shown = typeSpecificAdvancedFields(form.apiType);
  return (
    <>
      <FlagField
        label="Prune previous thinking blocks"
        checked={form.pruneThinking}
        onChange={value => patch({ pruneThinking: value })}
      >
        Strips thinking/reasoning from older messages. Enable if your provider rejects thinking
        blocks.
      </FlagField>

      <FlagField
        label="Prune empty text blocks"
        checked={form.pruneEmptyText}
        onChange={value => patch({ pruneEmptyText: value })}
      >
        Removes empty text blocks from older messages.
      </FlagField>

      <FlagField
        label="Subscription service"
        checked={form.isSubscription}
        onChange={value => patch({ isSubscription: value })}
      >
        {isChatgptSubscription
          ? 'Track all usage as $0. Off (default) keeps API-list prices so the totals show what this usage would have cost per token.'
          : 'Flat-rate subscription — all usage is tracked as $0.'}
      </FlagField>

      <ReasoningDialectField
        dialects={shown.reasoningDialects}
        dialect={effectiveReasoningDialect(form)}
        override={form.reasoningDialectOverride}
        onDialectChange={value => patch({ reasoningDialect: value })}
        onOverrideChange={value => patch({ reasoningDialectOverride: value })}
      />

      {shown.enforceGenuineAnthropic && (
        <FlagField
          label="Enforce genuine Anthropic"
          checked={form.enforceGenuineAnthropic}
          onChange={value => patch({ enforceGenuineAnthropic: value })}
        >
          Rejects responses with zero cache activity or unsigned thinking blocks — catches API
          routers silently forwarding to non-Anthropic providers.
        </FlagField>
      )}

      <FlagField
        label="Nudge model to think"
        checked={form.nudgeThinking}
        onChange={value => patch({ nudgeThinking: value })}
      >
        Appends a thinking prompt to the last user message. Useful for models that need a nudge to
        use chain-of-thought.
      </FlagField>

      <FlagField
        label="Mandate chain-of-thought"
        checked={form.mandateCoT}
        onChange={value => patch({ mandateCoT: value })}
      >
        Requires at least one response with reasoning tokens or thinking blocks per agentic run.
        Triggers minion savepoint rollback on retry.
      </FlagField>

      <FlagField
        label="Treat empty output as error"
        checked={form.treatEmptyOutputAsError}
        onChange={value => patch({ treatEmptyOutputAsError: value })}
      >
        Returns an error when a turn produces text that trims to empty and has no tool calls.
        Catches degenerate responses from unreliable providers.
      </FlagField>

      {shown.treatFallbackAsError && (
        <FlagField
          label="Treat fallback as error"
          checked={form.treatFallbackAsError}
          onChange={value => patch({ treatFallbackAsError: value })}
        >
          Surfaces an error when the SDK hands the request to a different model (a fallback block).
          Off shows an inline notice instead and keeps the response.
        </FlagField>
      )}

      {shown.useStreamAccumulator && (
        <FlagField
          label="Use stream accumulator (Responses API)"
          checked={form.useStreamAccumulator}
          onChange={value => patch({ useStreamAccumulator: value })}
        >
          Builds the response from streaming events instead of relying on the SDK's final response
          object. Enable for third-party Responses API providers (e.g. OpenRouter) that emit
          non-spec frames like <code className="rounded bg-gray-100 px-1">response.keep_alive</code>{' '}
          during long reasoning calls, or that return empty content from{' '}
          <code className="rounded bg-gray-100 px-1">stream.finalResponse()</code>. Has no effect on
          stock OpenAI or non-Responses providers.
        </FlagField>
      )}

      {shown.flexTierSupported && (
        <FlagField
          label="Supports flex / batch tier"
          checked={form.flexTierSupported}
          onChange={value => patch({ flexTierSupported: value })}
        >
          Provider accepts <code className="rounded bg-gray-100 px-1">service_tier: "flex"</code>{' '}
          (OpenAI) or <code className="rounded bg-gray-100 px-1">serviceTier: "flex"</code> (Gemini)
          for a discounted, lower-priority service tier. Enable only if your provider documents this
          — most OpenAI-compatible endpoints don't.
        </FlagField>
      )}
    </>
  );
}

function applyPatch(form: ApiDefinitionFormState, fields: FormPatch): ApiDefinitionFormState {
  return { ...form, ...fields };
}

function initialForm(definition: APIDefinition | undefined): ApiDefinitionFormState {
  return definition ? apiDefinitionToForm(definition) : EMPTY_API_DEFINITION_FORM;
}

interface ApiDefinitionFormProps {
  /** The definition to edit. Omitted, the form adds a new one. */
  definition?: APIDefinition;
  /**
   * Which half opens first. An existing definition's Advanced button opens
   * straight into the advanced settings, and Save there writes only those.
   */
  initialView?: 'basic' | 'advanced';
  /** Called on Cancel and after a successful save. */
  onClose: () => void;
}

/**
 * The add and edit forms for an API definition. The fields live in one
 * reducer-held object seeded once on mount; the parent unmounts the form to
 * discard it, so there is no reset path to keep in sync.
 */
export default function ApiDefinitionForm({
  definition,
  initialView = 'basic',
  onClose,
}: ApiDefinitionFormProps) {
  const { saveAPIDefinition, refreshModels, refreshAPIDefinitions } = useAppActions();
  const { showAlert } = useAlert();
  const [form, patch] = useReducer(applyPatch, definition, initialForm);
  const [view, setView] = useState(initialView);
  const [isSaving, setIsSaving] = useState(false);

  const isClaudeAgentForm = form.apiType === 'claude-agent';
  // chatgpt-subscription authenticates through the sign-in panel (no API key)
  // — only the CORS proxy (worker mode) and the custom model list still apply.
  const isChatgptSubscriptionForm = form.apiType === 'chatgpt-subscription';
  const hideProviderFields = hidesProviderFields(form.apiType);

  const handleSave = async () => {
    if (!form.name.trim()) {
      await showAlert('Error', 'Name is required');
      return;
    }

    // API key is required unless the provider can run keyless: local providers
    // (Ollama, LM Studio) or claude-agent, where an empty key falls back to the
    // host `claude` CLI's OAuth credentials (the whole point of the
    // subscription path).
    if (!apiKeyOptional({ isLocal: form.isLocal, apiType: form.apiType }) && !form.apiKey.trim()) {
      await showAlert('Error', 'API Key is required for this provider (or mark as Local)');
      return;
    }

    setIsSaving(true);
    try {
      const def = formToApiDefinition(form, {
        id: definition?.id ?? generateUniqueId(`api_${form.apiType}`),
        existing: definition,
        now: new Date(),
      });
      await saveAPIDefinition(def);
      // Force-refresh so a new key or endpoint shows its model list right away.
      await refreshModels(def.id, true);
      onClose();
    } catch (err) {
      // The form stays open with everything typed
      void showAlert('Not saved', err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveAdvanced = async () => {
    if (!definition) return;
    setIsSaving(true);
    try {
      await saveAPIDefinition({
        ...definition,
        advancedSettings: buildAdvancedSettings(form),
        updatedAt: new Date(),
      });
      onClose();
    } catch (err) {
      void showAlert('Not saved', err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  };

  const handleSignInChanged = async (apiDefId: string) => {
    await refreshAPIDefinitions();
    await refreshModels(apiDefId, true);
  };

  if (view === 'advanced') {
    return (
      <div>
        {definition ? (
          <div className="mb-4 text-base font-semibold text-gray-900">
            Advanced: {getApiDefinitionIcon(definition)} {getApiTypeDisplayName(definition.apiType)}
          </div>
        ) : (
          <div className="mb-4 flex items-center gap-2">
            <button
              onClick={() => setView('basic')}
              className="text-sm text-blue-600 hover:text-blue-800"
            >
              ← Back
            </button>
            <span className="text-base font-semibold text-gray-900">Advanced Settings</span>
          </div>
        )}

        <AdvancedFields form={form} patch={patch} />

        {/* The add form saves everything from its basic view. */}
        {definition && (
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={onClose} className={SECONDARY_BUTTON_CLASS}>
              Cancel
            </button>
            <button
              onClick={handleSaveAdvanced}
              disabled={isSaving}
              className={PRIMARY_BUTTON_CLASS}
            >
              {isSaving && <Spinner size={14} colorClass="border-white" />}
              Save
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      {definition ? (
        <div className="mb-4 text-base font-semibold text-gray-900">
          Edit: {getApiDefinitionIcon(definition)} {getApiTypeDisplayName(definition.apiType)}
        </div>
      ) : (
        <>
          <div className="mb-4 text-base font-semibold text-gray-900">Add New API Definition</div>

          <label className={LABEL_CLASS}>API Type</label>
          <div className="mb-3 grid grid-cols-2 gap-2">
            {API_TYPE_CHOICES.map(type => (
              <button
                key={type.id}
                onClick={() => patch({ apiType: type.id })}
                className={`flex items-center justify-center rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                  form.apiType === type.id
                    ? 'border-blue-600 bg-blue-50 text-blue-900'
                    : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
                }`}
              >
                <span className="mr-2">{type.icon}</span>
                {type.name}
              </button>
            ))}
          </div>
          {form.apiType === 'bedrock' && (
            <p className="mb-3 text-xs text-gray-500">
              💡 You can also choose "Anthropic" to use Claude models in Bedrock.
            </p>
          )}
        </>
      )}

      <label className={LABEL_CLASS}>Name *</label>
      <input
        type="text"
        className={`mb-3 ${INPUT_CLASS}`}
        placeholder="e.g., xAI, OpenRouter, My OpenAI"
        value={form.name}
        onChange={e => patch({ name: e.target.value })}
      />

      <label className={LABEL_CLASS}>Icon (Optional)</label>
      <input
        type="text"
        className={`mb-3 ${INPUT_CLASS}`}
        placeholder={getApiTypeDefaultIcon(form.apiType)}
        value={form.icon}
        onChange={e => patch({ icon: e.target.value })}
        maxLength={2}
      />

      {!hideProviderFields && (
        <>
          <label className={LABEL_CLASS}>Base URL (Optional)</label>
          <input
            type="text"
            className={`${INPUT_CLASS} ${form.apiType === 'anthropic' ? 'mb-1' : 'mb-3'}`}
            placeholder="Leave empty for provider default"
            value={form.baseUrl}
            onChange={e => patch({ baseUrl: e.target.value })}
          />
          {form.apiType === 'anthropic' && (
            <p className="mb-3 text-xs text-gray-500">
              You can enter <code className="rounded bg-gray-100 px-1">bedrock:&lt;region&gt;</code>{' '}
              to use Claude models in Bedrock
            </p>
          )}
          {form.apiType === 'bedrock' && (
            <p className="mb-3 text-xs text-gray-500">
              You can enter just a region (e.g.,{' '}
              <code className="rounded bg-gray-100 px-1">us-west-2</code>) instead of the full URL
            </p>
          )}

          <label className="mb-3 flex cursor-pointer items-center">
            <input
              type="checkbox"
              checked={form.isLocal}
              onChange={e => patch({ isLocal: e.target.checked })}
              className="mr-2 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <span className="text-sm text-gray-700">🏠 Local provider (API key optional)</span>
          </label>
        </>
      )}

      {isChatgptSubscriptionForm ? (
        // Sign-in needs a stored definition to hold the tokens.
        definition ? (
          <ChatgptSignInPanel
            apiDef={definition}
            onChanged={() => handleSignInChanged(definition.id)}
          />
        ) : (
          <div className="mb-4 rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-600">
            No API key. Save this definition, then open <strong>Edit</strong> and sign in with your
            ChatGPT account. Usage bills your ChatGPT Plus/Pro plan — OpenAI tolerates third-party
            apps on subscription sign-in but does not guarantee it; keep it to personal use.
          </div>
        )
      ) : (
        <>
          <label className={LABEL_CLASS}>
            API Key {form.isLocal || isClaudeAgentForm ? '(Optional)' : '*'}
          </label>
          <input
            type="password"
            className={`mb-1 ${INPUT_CLASS}`}
            placeholder={
              isClaudeAgentForm
                ? 'Leave blank to use host `claude` CLI credentials'
                : 'Enter your API key'
            }
            value={form.apiKey}
            onChange={e => patch({ apiKey: e.target.value })}
          />
          {isClaudeAgentForm ? (
            <p className="mb-4 text-xs text-gray-500">
              Empty → host CLI OAuth (subscription billed). Paste an{' '}
              <code className="rounded bg-gray-100 px-1">sk-ant-oat01-…</code> OAuth token for
              explicit subscription auth, or an{' '}
              <code className="rounded bg-gray-100 px-1">sk-ant-api03-…</code> key for pay-per-token
              (defeats the purpose).
            </p>
          ) : (
            <div className="mb-4" />
          )}
        </>
      )}

      {isChatgptSubscriptionForm && (
        <ModelListFields
          builtInListName="ChatGPT backend"
          extraModelIds={form.extraModelIds}
          modelListReplaced={form.modelsEndpointDisabled}
          onExtraModelIdsChange={value => patch({ extraModelIds: value })}
          onModelListReplacedChange={value => patch({ modelsEndpointDisabled: value })}
        />
      )}

      {isClaudeAgentForm && <ClaudeAgentFields form={form} patch={patch} />}

      {!hideProviderFields && (
        <>
          <label className={LABEL_CLASS}>Models Endpoint (Optional)</label>
          <input
            type="text"
            className={`mb-1 ${INPUT_CLASS} ${form.modelsEndpointDisabled ? 'cursor-not-allowed bg-gray-100 text-gray-400' : ''}`}
            placeholder="SDK default"
            value={form.modelsEndpoint}
            onChange={e => patch({ modelsEndpoint: e.target.value })}
            disabled={form.modelsEndpointDisabled}
          />
          <label className="mb-4 flex items-center gap-2 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={form.modelsEndpointDisabled}
              onChange={e => patch({ modelsEndpointDisabled: e.target.checked })}
              className="rounded border-gray-300"
            />
            Models endpoint not supported
          </label>

          <label className={LABEL_CLASS}>Extra Model IDs (Optional)</label>
          <textarea
            className="mb-1 w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
            placeholder="one-model-id-per-line"
            rows={3}
            value={form.extraModelIds}
            onChange={e => patch({ extraModelIds: e.target.value })}
          />
          <p className="mb-4 text-xs text-gray-500">
            Add model IDs not listed by the provider (one per line)
          </p>
        </>
      )}

      {showsProxyFields(form.apiType) && (
        <>
          <label className={LABEL_CLASS}>CORS Proxy URL (Optional)</label>
          <input
            type="text"
            className={`mb-1 ${INPUT_CLASS}`}
            placeholder="e.g., https://myserver.com/cors-proxy"
            value={form.proxyUrl}
            onChange={e => patch({ proxyUrl: e.target.value })}
          />
          <p className="mb-4 text-xs text-gray-500">
            {isChatgptSubscriptionForm
              ? 'Required in worker mode: the browser cannot reach chatgpt.com or auth.openai.com directly. The proxy must allow both hosts. Server mode does not need it.'
              : 'Routes API traffic through a CORS proxy server'}
          </p>
          <label className={LABEL_CLASS}>CORS Proxy Auth Token (Optional)</label>
          <input
            type="password"
            className={`mb-1 ${INPUT_CLASS}`}
            placeholder="shared secret"
            value={form.proxyAuthToken}
            onChange={e => patch({ proxyAuthToken: e.target.value })}
          />
          <p className="mb-4 text-xs text-gray-500">
            Sent as the X-Proxy-Auth header to authenticate with the proxy
          </p>
        </>
      )}

      <div className="flex justify-end gap-2">
        {!definition && (
          <button onClick={() => setView('advanced')} className={SECONDARY_BUTTON_CLASS}>
            Advanced
          </button>
        )}
        <button onClick={onClose} className={SECONDARY_BUTTON_CLASS}>
          Cancel
        </button>
        <button onClick={handleSave} disabled={isSaving} className={PRIMARY_BUTTON_CLASS}>
          {isSaving && <Spinner size={14} colorClass="border-white" />}
          {definition ? 'Save' : 'Add'}
        </button>
      </div>
    </div>
  );
}
