import test from 'node:test';
import assert from 'node:assert/strict';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { googleLogin } from '../controllers/authController.js';
import { protect } from '../middlewares/authMiddleware.js';

const GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';

const makeUser = (overrides = {}) => ({
  _id: 'user-123',
  name: 'Quiz Learner',
  email: 'learner@example.com',
  googleId: 'google-sub-123',
  emailVerified: true,
  save: async function save() {},
  getSignedJwtToken: () => 'application-jwt',
  ...overrides,
});

const makeResponse = () => ({
  statusCode: 200,
  body: null,
  status(statusCode) {
    this.statusCode = statusCode;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
});

const configureMocks = (context, { payload, findOne, create, verificationError } = {}) => {
  const originalGoogleClientId = process.env.GOOGLE_CLIENT_ID;
  const originalVerifyIdToken = OAuth2Client.prototype.verifyIdToken;
  const originalFindOne = User.findOne;
  const originalCreate = User.create;

  process.env.GOOGLE_CLIENT_ID = GOOGLE_CLIENT_ID;
  OAuth2Client.prototype.verifyIdToken = async ({ idToken, audience }) => {
    assert.equal(idToken, 'google-id-token');
    assert.equal(audience, GOOGLE_CLIENT_ID);
    if (verificationError) throw verificationError;
    return { getPayload: () => payload };
  };
  User.findOne = findOne || (async () => null);
  User.create = create || (async () => makeUser());

  context.after(() => {
    OAuth2Client.prototype.verifyIdToken = originalVerifyIdToken;
    User.findOne = originalFindOne;
    User.create = originalCreate;
    if (originalGoogleClientId === undefined) {
      delete process.env.GOOGLE_CLIENT_ID;
    } else {
      process.env.GOOGLE_CLIENT_ID = originalGoogleClientId;
    }
  });
};

const verifiedPayload = {
  sub: 'google-sub-123',
  email: 'learner@example.com',
  email_verified: true,
  name: 'Quiz Learner',
};

const callGoogleLogin = async (body = { idToken: 'google-id-token' }) => {
  const req = { body };
  const res = makeResponse();
  await googleLogin(req, res);
  return res;
};

test('creates a Google account and issues the existing application JWT', async (context) => {
  const lookupFilters = [];
  let createdUser;
  configureMocks(context, {
    payload: verifiedPayload,
    findOne: async (filter) => {
      lookupFilters.push(filter);
      return null;
    },
    create: async (userData) => {
      createdUser = makeUser(userData);
      return createdUser;
    },
  });

  const response = await callGoogleLogin();

  assert.equal(lookupFilters[0].googleId, verifiedPayload.sub);
  assert.equal(createdUser.googleId, verifiedPayload.sub);
  assert.equal(createdUser.emailVerified, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.token, 'application-jwt');
  assert.equal(response.body.user.id, 'user-123');
});

test('links an existing email account only to a verified Google identity', async (context) => {
  let saveCount = 0;
  const existingUser = makeUser({
    googleId: undefined,
    emailVerified: false,
    save: async function save() { saveCount += 1; },
  });
  configureMocks(context, {
    payload: verifiedPayload,
    findOne: async (filter) => (filter.googleId ? null : existingUser),
  });

  const response = await callGoogleLogin();

  assert.equal(existingUser.googleId, verifiedPayload.sub);
  assert.equal(existingUser.emailVerified, true);
  assert.equal(saveCount, 1);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.token, 'application-jwt');
});

test('repeated sign-in for the same Google subject reuses the existing account', async (context) => {
  const existingUser = makeUser();
  let createCount = 0;
  configureMocks(context, {
    payload: verifiedPayload,
    findOne: async (filter) => (filter.googleId === verifiedPayload.sub ? existingUser : null),
    create: async () => { createCount += 1; return existingUser; },
  });

  const firstResponse = await callGoogleLogin();
  const secondResponse = await callGoogleLogin();

  assert.equal(firstResponse.statusCode, 200);
  assert.equal(secondResponse.statusCode, 200);
  assert.equal(createCount, 0);
});

test('rejects an invalid Google ID token', async (context) => {
  configureMocks(context, { verificationError: new Error('invalid token') });

  const response = await callGoogleLogin();

  assert.equal(response.statusCode, 401);
  assert.match(response.body.message, /could not verify/i);
});

test('rejects Google identities without a verified email', async (context) => {
  configureMocks(context, {
    payload: { ...verifiedPayload, email_verified: false },
    findOne: async () => {
      assert.fail('An unverified email must not be used for account lookup');
    },
  });

  const response = await callGoogleLogin();

  assert.equal(response.statusCode, 401);
  assert.match(response.body.message, /verified email/i);
});

test('rejects an email already linked to a different Google subject', async (context) => {
  configureMocks(context, {
    payload: verifiedPayload,
    findOne: async (filter) => (filter.googleId
      ? null
      : makeUser({ googleId: 'different-google-sub' })),
  });

  const response = await callGoogleLogin();

  assert.equal(response.statusCode, 409);
  assert.match(response.body.message, /different Google account/i);
});

test('requires a Google ID token', async (context) => {
  configureMocks(context);

  const response = await callGoogleLogin({});

  assert.equal(response.statusCode, 400);
  assert.match(response.body.message, /ID token is required/i);
});

test('handles simultaneous first sign-ins without creating duplicate users', async (context) => {
  const existingUser = makeUser();
  let lookupCount = 0;
  configureMocks(context, {
    payload: verifiedPayload,
    findOne: async (filter) => {
      lookupCount += 1;
      return filter.googleId && lookupCount > 2 ? existingUser : null;
    },
    create: async () => {
      const error = new Error('duplicate Google identifier');
      error.code = 11000;
      throw error;
    },
  });

  const response = await callGoogleLogin();

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.token, 'application-jwt');
});

test('the existing protected-route middleware accepts the application JWT', async (context) => {
  const originalSecret = process.env.JWT_SECRET;
  const originalFindById = User.findById;
  const currentUser = makeUser();
  const jwtSecret = 'google-auth-test-secret';
  process.env.JWT_SECRET = jwtSecret;
  User.findById = () => ({ select: async () => currentUser });

  context.after(() => {
    User.findById = originalFindById;
    if (originalSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalSecret;
    }
  });

  const applicationToken = jwt.sign({ id: currentUser._id }, jwtSecret, { expiresIn: '1h' });
  const req = { headers: { authorization: `Bearer ${applicationToken}` } };
  const res = makeResponse();
  let nextCalled = false;

  await protect(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(req.user, currentUser);
});

test('the existing protected-route middleware rejects requests without a token', async () => {
  const req = { headers: {} };
  const res = makeResponse();

  await protect(req, res, () => assert.fail('Unauthenticated requests must not pass'));

  assert.equal(res.statusCode, 401);
});

test('allows passwordless Google users while requiring passwords for local accounts', async () => {
  const localAccount = new User({
    name: 'Local Learner',
    email: 'local@example.com',
  });
  const googleAccount = new User({
    name: 'Google Learner',
    email: 'google@example.com',
    googleId: 'google-sub-passwordless',
    emailVerified: true,
  });

  await assert.rejects(localAccount.validate(), /password/i);
  await assert.doesNotReject(googleAccount.validate());
  assert.equal(await User.prototype.matchPassword.call({ password: undefined }, 'password'), false);
});
