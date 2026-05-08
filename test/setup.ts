jest.mock('@thallesp/nestjs-better-auth', () => ({
  AllowAnonymous: () => () => {},
  OptionalAuth: () => () => {},
  Session: () => () => {},
  AuthGuard: class {},
  BetterAuthModule: {
    forRoot: jest.fn().mockReturnValue({
      module: class {},
      providers: [],
    }),
  },
  AuthModule: {
    forRoot: jest.fn().mockReturnValue({
      module: class {},
      providers: [],
    }),
  },
}));

// Stub out the ESM `better-auth` ecosystem so tests that transitively load
// `src/link/auth.ts` (e.g. via AppModule) don't fail on `import` parsing.
jest.mock(
  'better-auth',
  () => ({
    betterAuth: jest.fn().mockReturnValue({
      $context: { internalAdapter: { updateSession: jest.fn() } },
      api: {},
      handler: jest.fn(),
    }),
  }),
  { virtual: true },
);
jest.mock(
  'better-auth/plugins',
  () => ({ emailOTP: () => ({}), openAPI: () => ({}), admin: () => ({}) }),
  { virtual: true },
);
jest.mock('better-sqlite3', () => class {}, { virtual: true });
