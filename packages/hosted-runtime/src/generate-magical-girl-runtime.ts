import {
  createGenerateMagicalGirlService,
  type GenerateMagicalGirlInput,
  type GenerateMagicalGirlService,
  type MagicalGirlGenerationResult,
} from '@mahoshojo/hosted-api/generate-magical-girl';
import { MAGICAL_GIRL_GENERATION_CONFIG, type AIGeneratedMagicalGirl } from '@mahoshojo/ai-core/name-generation';
export { MAGICAL_GIRL_GENERATION_CONFIG, MAGICAL_GIRL_GENERATION_SCHEMA, MAGICAL_GIRL_SYSTEM_PROMPT, buildMagicalGirlGenerationPrompt, type AIGeneratedMagicalGirl, type MainColor } from '@mahoshojo/ai-core/name-generation';

export const MAGICAL_GIRL_ACTION_TYPE = 'magical_girl_generate' as const;
export const MAGICAL_GIRL_PROVIDER_MODE = 'system' as const;

export type GenerateMagicalGirlAiOptions = {
  channelContext: {
    providerId: 'system';
    modelId: 'default';
  };
};

export interface GenerateMagicalGirlRuntimeDependencies {
  checkRateLimit(_input: {
    request: Request;
    actionType: typeof MAGICAL_GIRL_ACTION_TYPE;
    providerMode: typeof MAGICAL_GIRL_PROVIDER_MODE;
  }): Promise<Response | null>;
  enforceSafety(_input: {
    request: Request;
    name: string;
    language: string;
  }): Promise<Response | null>;
  generateWithAI(
    _input: GenerateMagicalGirlInput,
    _config: typeof MAGICAL_GIRL_GENERATION_CONFIG,
    _options: GenerateMagicalGirlAiOptions,
  ): Promise<AIGeneratedMagicalGirl>;
  sign(_payload: MagicalGirlGenerationResult & { templateId: string }): Promise<string | null>;
  recordActivity(_request: Request): void;
  logError(_error: unknown, _context: { nameLength: number }): void;
  cooldownMs: number;
}

export interface GenerateMagicalGirlRuntime {
  readonly service: GenerateMagicalGirlService;
  readonly generateMagicalGirlWithAI: (
    _realName: string,
    _language: string,
  ) => Promise<AIGeneratedMagicalGirl>;
}

export const createGenerateMagicalGirlRuntime = (
  dependencies: GenerateMagicalGirlRuntimeDependencies,
): GenerateMagicalGirlRuntime => {
  const ports = Object.freeze({ ...dependencies });
  const generateMagicalGirlWithAI = (
    realName: string,
    language: string,
  ): Promise<AIGeneratedMagicalGirl> => ports.generateWithAI(
    { realName, language },
    MAGICAL_GIRL_GENERATION_CONFIG,
    {
      channelContext: {
        providerId: MAGICAL_GIRL_PROVIDER_MODE,
        modelId: 'default',
      },
    },
  );

  const service = createGenerateMagicalGirlService({
    checkRateLimit: (request) => ports.checkRateLimit({
      request,
      actionType: MAGICAL_GIRL_ACTION_TYPE,
      providerMode: MAGICAL_GIRL_PROVIDER_MODE,
    }),
    enforceSafety: (request, { name, language }) => ports.enforceSafety({
      request,
      name,
      language,
    }),
    generate: ({ realName, language }) => generateMagicalGirlWithAI(realName, language),
    sign: ports.sign,
    recordActivity: ports.recordActivity,
    logError: ports.logError,
    retryAfterSeconds: Math.ceil(ports.cooldownMs / 1000),
  });

  return Object.freeze({ service, generateMagicalGirlWithAI });
};
