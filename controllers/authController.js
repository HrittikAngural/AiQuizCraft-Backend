import User from '../models/User.js';
import { OAuth2Client } from 'google-auth-library';

const createSessionResponse = (res, user, status = 200) => {
  const token = user.getSignedJwtToken();
  return res.status(status).json({
    success: true,
    token,
    user: {
      id: user._id,
      name: user.name,
      email: user.email,
    },
  });
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// @desc    Register a new user
// @route   POST /api/auth/register
// @access  Public
export const registerUser = async (req, res) => {
  try {
    const { name, email, password } = req.body;
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';

    if (!name?.trim() || !normalizedEmail || typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({ message: 'Please provide a name, valid email, and password of at least 6 characters' });
    }

    // Check if user already exists
    const emailLookup = new RegExp(`^${escapeRegex(normalizedEmail)}$`, 'i');
    const userExists = await User.findOne({ email: emailLookup });
    if (userExists) {
      return res.status(400).json({ message: 'User already exists' });
    }

    // Create new user
    const user = await User.create({
      name,
      email: normalizedEmail,
      password,
    });

    // Generate token
    const token = user.getSignedJwtToken();

    res.status(201).json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Login user
// @route   POST /api/auth/login
// @access  Public
export const loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Check if email and password are provided
    if (!email || !password) {
      return res
        .status(400)
        .json({ message: 'Please provide email and password' });
    }

    // Check if user exists
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const emailLookup = new RegExp(`^${escapeRegex(normalizedEmail)}$`, 'i');
    const user = await User.findOne({ email: emailLookup }).select('+password');
    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Check if password matches
    const isMatch = await user.matchPassword(password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Generate token
    const token = user.getSignedJwtToken();

    res.status(200).json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const googleLogin = async (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const { idToken } = req.body || {};

  if (!clientId) {
    return res.status(503).json({ message: 'Google sign-in is not configured on the server' });
  }
  if (typeof idToken !== 'string' || !idToken.trim()) {
    return res.status(400).json({ message: 'A Google ID token is required' });
  }

  let payload;
  try {
    const ticket = await new OAuth2Client(clientId).verifyIdToken({
      idToken,
      audience: clientId,
    });
    payload = ticket.getPayload();
  } catch {
    return res.status(401).json({ message: 'Google sign-in could not verify your account. Please try again.' });
  }

  if (
    !payload?.sub ||
    typeof payload.email !== 'string' ||
    payload.email_verified !== true
  ) {
    return res.status(401).json({ message: 'Google must provide a verified email address to sign in' });
  }

  const email = payload.email.trim().toLowerCase();
  const googleId = payload.sub;
  const name = typeof payload.name === 'string' && payload.name.trim()
    ? payload.name.trim()
    : email.split('@')[0];
  const emailLookup = new RegExp(`^${escapeRegex(email)}$`, 'i');

  try {
    let user = await User.findOne({ googleId });

    if (!user) {
      user = await User.findOne({ email: emailLookup });

      if (user) {
        if (user.googleId && user.googleId !== googleId) {
          return res.status(409).json({
            message: 'This email is linked to a different Google account. Sign in with your original account.',
          });
        }

        user.googleId = googleId;
        user.emailVerified = true;
        await user.save();
      } else {
        user = await User.create({
          name,
          email,
          googleId,
          emailVerified: true,
        });
      }
    }

    return createSessionResponse(res, user);
  } catch (error) {
    if (error.code === 11000) {
      try {
        const existingGoogleUser = await User.findOne({ googleId });
        if (existingGoogleUser) return createSessionResponse(res, existingGoogleUser);
      } catch (lookupError) {
        console.error('Could not resolve a concurrent Google sign-in:', lookupError);
        return res.status(500).json({ message: 'Google sign-in could not be completed. Please try again.' });
      }

      return res.status(409).json({
        message: 'This email is linked to a different account. Sign in with that account first.',
      });
    }

    console.error('Error completing Google sign-in:', error);
    return res.status(500).json({ message: 'Google sign-in could not be completed. Please try again.' });
  }
};

// @desc    Get user profile
// @route   GET /api/auth/profile
// @access  Private
export const getProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    res.status(200).json({
      success: true,
      user
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
