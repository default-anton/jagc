import { join } from 'node:path';

import { type AuthCredential, AuthStorage, ModelRegistry } from '@mariozechner/pi-coding-agent';

const providerEnvVarHints: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  groq: 'GROQ_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  xai: 'XAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  'vercel-ai-gateway': 'AI_GATEWAY_API_KEY',
  zai: 'ZAI_API_KEY',
  opencode: 'OPENCODE_API_KEY',
  huggingface: 'HF_TOKEN',
  kimi: 'KIMI_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  'minimax-cn': 'MINIMAX_CN_API_KEY',
  'azure-openai': 'AZURE_OPENAI_API_KEY',
};

export interface ProviderModelStatus {
  provider: string;
  model_id: string;
  name: string;
  reasoning: boolean;
  available: boolean;
}

export interface ProviderAuthStatus {
  provider: string;
  has_auth: boolean;
  credential_type: AuthCredential['type'] | null;
  oauth_supported: boolean;
  env_var_hint: string | null;
  total_models: number;
  available_models: number;
}

export interface ProviderCatalogEntry extends ProviderAuthStatus {
  models: ProviderModelStatus[];
}

export class PiAuthService {
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistry;

  constructor(agentDir: string) {
    this.authStorage = new AuthStorage(join(agentDir, 'auth.json'));
    this.modelRegistry = new ModelRegistry(this.authStorage, join(agentDir, 'models.json'));
  }

  getProviderStatuses(): ProviderAuthStatus[] {
    return this.getProviderCatalog().map(({ models, ...provider }) => provider);
  }

  getProviderCatalog(): ProviderCatalogEntry[] {
    this.authStorage.reload();
    this.modelRegistry.refresh();

    const allModels = this.modelRegistry.getAll();
    const availableModels = this.modelRegistry.getAvailable();
    const authProviders = Object.keys(this.authStorage.getAll());

    const providers = new Set<string>([...allModels.map((model) => model.provider), ...authProviders]);
    const oauthProviders = new Set(this.authStorage.getOAuthProviders().map((provider) => provider.id));

    const allModelCounts = countByProvider(allModels.map((model) => model.provider));
    const availableModelCounts = countByProvider(availableModels.map((model) => model.provider));
    const availableModelKeys = new Set(availableModels.map((model) => `${model.provider}/${model.id}`));

    return [...providers]
      .sort((left, right) => left.localeCompare(right))
      .map((provider) => {
        const credential = this.authStorage.get(provider);

        const models = allModels
          .filter((model) => model.provider === provider)
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((model) => ({
            provider,
            model_id: model.id,
            name: model.name,
            reasoning: model.reasoning,
            available: availableModelKeys.has(`${model.provider}/${model.id}`),
          }));

        return {
          provider,
          has_auth: this.authStorage.hasAuth(provider),
          credential_type: credential?.type ?? null,
          oauth_supported: oauthProviders.has(provider),
          env_var_hint: providerEnvVarHints[provider] ?? null,
          total_models: allModelCounts.get(provider) ?? 0,
          available_models: availableModelCounts.get(provider) ?? 0,
          models,
        };
      });
  }
}

function countByProvider(providers: string[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const provider of providers) {
    counts.set(provider, (counts.get(provider) ?? 0) + 1);
  }

  return counts;
}
