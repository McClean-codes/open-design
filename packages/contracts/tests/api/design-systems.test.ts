import { describe, expectTypeOf, it } from 'vitest';

import type {
  ResolveDesignSystemIntentApiResponse,
  ResolveDesignSystemIntentRequest,
  ResolveDesignSystemIntentResponse,
} from '../../src/index.js';

describe('design-system tool API contract', () => {
  it('shares the resolve-intent request and response envelope', () => {
    expectTypeOf<ResolveDesignSystemIntentRequest>().toMatchTypeOf<{
      intent: string;
      designSystemId?: string;
    }>();
    expectTypeOf<ResolveDesignSystemIntentResponse>().toMatchTypeOf<{
      designSystemId: string;
      runtime: 'structured';
    }>();
    expectTypeOf<ResolveDesignSystemIntentApiResponse>().toMatchTypeOf<
      ResolveDesignSystemIntentResponse | { error: { code: string; message: string } }
    >();
  });
});
