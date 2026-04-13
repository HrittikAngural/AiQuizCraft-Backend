import dotenv from 'dotenv';

dotenv.config();

async function main() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.error('GEMINI_API_KEY is not set in environment.');
    process.exit(1);
  }

  const url = `https://generativelanguage.googleapis.com/v1/models?key=${encodeURIComponent(key)}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text();
      console.error(`Model list request failed: ${res.status} ${res.statusText}\n${body}`);
      process.exit(2);
    }

    const data = await res.json();
    const models = Array.isArray(data.models) ? data.models : [];

    if (!models.length) {
      console.log('No models returned by the REST API. Full response:');
      console.log(JSON.stringify(data, null, 2));
      process.exit(0);
    }

    console.log('Discovered models:');
    for (const m of models) {
      const name = m?.name || m?.displayName || m?.id || '(unknown)';
      const methods = m?.supportedMethods || m?.supported_methods || m?.methods || [];
      console.log(`- ${name}    methods: ${Array.isArray(methods) ? methods.join(', ') : methods}`);
    }
  } catch (err) {
    console.error('Error listing models (fetch):', err?.message || err);
    process.exit(2);
  }
}

main();
