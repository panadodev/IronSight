const KEY =
  "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";

const TEST_INPUTS = [
  "gg wp nice game",
  "I will find you and hurt you seriously",
  "kill yourself you worthless piece of trash",
];

async function testModeration(text, maxRetries = 5) {
  let delay = 2000;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch("https://api.openai.com/v1/moderations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${KEY}`,
      },
      body: JSON.stringify({ model: "omni-moderation-latest", input: text }),
    });

    if (res.status === 429) {
      const retryAfter = res.headers.get("retry-after");
      const wait = retryAfter ? parseInt(retryAfter, 10) * 1000 : delay;
      console.log(
        `  [429] rate limited — waiting ${wait}ms (attempt ${attempt + 1}/${maxRetries})`,
      );
      await new Promise((r) => setTimeout(r, wait));
      delay *= 2;
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OpenAI moderation API error ${res.status}: ${body}`);
    }

    const data = await res.json();
    const result = data.results?.[0];
    if (!result) throw new Error("No results in response");

    return {
      flagged: result.flagged,
      categories: Object.entries(result.categories)
        .filter(([, v]) => v)
        .map(([k]) => k),
      scores: Object.fromEntries(
        Object.entries(result.category_scores)
          .filter(([, v]) => v > 0.01)
          .sort(([, a], [, b]) => b - a)
          .map(([k, v]) => [k, v.toFixed(4)]),
      ),
    };
  }
  throw new Error(`Still rate limited after ${maxRetries} retries`);
}

for (const input of TEST_INPUTS) {
  console.log(`\nInput: "${input}"`);
  try {
    const r = await testModeration(input);
    console.log(
      `  flagged:    ${r.flagged}`,
      `\n  categories: ${r.categories.join(", ") || "(none)"}`,
      `\n  scores:     ${JSON.stringify(r.scores)}`,
    );
  } catch (err) {
    console.error("  ERROR:", err.message);
  }
}
