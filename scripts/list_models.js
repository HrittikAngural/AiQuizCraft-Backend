import dotenv from 'dotenv';
import Groq from 'groq-sdk';

dotenv.config();

async function main() {
  const key = process.env.GROQ_API_KEY;
  if (!key) {
    console.error('GROQ_API_KEY is not set in the backend .env file.');
    process.exit(1);
  }

  try {
    const groq = new Groq({ apiKey: key });
    const response = await groq.models.list();
    const models = response.data || [];

    if (!models.length) {
      console.log('Groq returned no models available to this API key.');
      return;
    }

    console.log('Groq models available to this API key:');
    for (const m of models) {
      console.log(`- ${m.id}`);
    }
  } catch (err) {
    console.error('Failed to list Groq models:', err?.message || err);
    process.exit(2);
  }
}

main();
