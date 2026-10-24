// Shared vocabulary of buyer concerns. Used to (a) generate the offline fixture
// corpus and (b) give the mock graph extractor something principled to count.
// Live runs let Claude discover themes freely; this list is only a fallback.

export interface Theme {
  id: string;
  label: string;
  polarity: -1 | 1;
  keywords: string[];
  phrases: string[]; // templates; {c} = competitor, {p} = price, {cat} = category
  objection?: string;
  answer?: string;
}

export const THEMES: Theme[] = [
  {
    id: "price",
    label: "Price / subscription fatigue",
    polarity: -1,
    keywords: ["expensive", "price", "subscription", "pricey", "cost", "pay", "free tier", "afford"],
    phrases: [
      "Another subscription? I already pay for {c}, I'm not adding {p}/mo on top.",
      "Honestly {p} a month feels steep for a {cat} tool when {c} has a free tier.",
      "Would pay once, but subscription fatigue is real. Every app wants {p}/month now.",
      "If it's under {p} I'd try it. Anything more and I'm sticking with {c}.",
    ],
    objection: "Too expensive for another subscription",
    answer: "Lead with a generous free tier or annual plan and show the time saved in money terms.",
  },
  {
    id: "privacy",
    label: "Privacy & data use",
    polarity: -1,
    keywords: ["privacy", "data", "train", "tracking", "gdpr", "secure", "leak"],
    phrases: [
      "Where does my data go? I left {c} because they started training on user content.",
      "No way I'm uploading my stuff to another {cat} startup without a clear privacy policy.",
      "Privacy is the dealbreaker for me with these {cat} apps.",
    ],
    objection: "Unclear what happens to my data",
    answer: "Put a plain-language data promise on the landing page: no training on user data, export and delete any time.",
  },
  {
    id: "accuracy",
    label: "Accuracy & reliability",
    polarity: -1,
    keywords: ["wrong", "accurate", "hallucinat", "buggy", "reliable", "crash", "broken"],
    phrases: [
      "Tried {c} and it was confidently wrong half the time. Burned me once, never again.",
      "The {cat} space is full of demos that break on real use. Show me it actually works.",
      "Reliability matters more than features. {c} keeps crashing on me.",
    ],
    objection: "Will it actually be accurate and reliable?",
    answer: "Show real before/after examples and publish an accuracy or uptime number with how it was measured.",
  },
  {
    id: "complexity",
    label: "Setup & learning curve",
    polarity: -1,
    keywords: ["complicated", "learning curve", "setup", "onboarding", "confusing", "steep"],
    phrases: [
      "{c} has every feature but the learning curve is brutal. I just want something simple.",
      "If onboarding takes more than five minutes I'm out.",
      "I spent a weekend setting up {c} and still don't use it.",
    ],
    objection: "Looks like it'll take too long to set up",
    answer: "Promise and demo a two-minute first win; import from the tools they already use.",
  },
  {
    id: "integration",
    label: "Integrations & switching cost",
    polarity: -1,
    keywords: ["integrat", "export", "import", "switch", "lock-in", "sync", "calendar"],
    phrases: [
      "Does it sync with {c}? All my stuff lives there; switching is a huge cost.",
      "Without import from {c} there's zero chance I move over.",
      "Lock-in scares me. Can I export everything if I leave?",
    ],
    objection: "I'd have to move everything over from my current tool",
    answer: "Ship one-click import from the top competitor and make export a visible feature.",
  },
  {
    id: "time_savings",
    label: "Saves time / reduces busywork",
    polarity: 1,
    keywords: ["save time", "faster", "hours", "productive", "automate", "busywork"],
    phrases: [
      "If this actually saves me a few hours a week it's an instant buy.",
      "Automating the boring part of {cat} is the dream. {c} only gets halfway there.",
      "Anything that cuts the busywork, I'm in.",
    ],
  },
  {
    id: "ai_trust",
    label: "Skepticism of AI tools",
    polarity: -1,
    keywords: ["ai slop", "gimmick", "hype", "wrapper", "chatgpt wrapper", "ai-powered"],
    phrases: [
      "Is this just a ChatGPT wrapper with a nicer UI? Why not use {c} directly?",
      "Every launch is 'AI-powered' now. I'm tired of the hype.",
      "I'll believe it when I see it. Most AI {cat} tools are gimmicks.",
    ],
    objection: "Feels like another AI wrapper",
    answer: "Say what it does that a general chatbot can't, with a side-by-side example.",
  },
  {
    id: "community_love",
    label: "Community enthusiasm",
    polarity: 1,
    keywords: ["love", "game changer", "finally", "recommend", "obsessed", "amazing"],
    phrases: [
      "Finally someone is building a decent {cat} tool. Following this closely.",
      "My friends switched from {c} and won't shut up about how much better it is.",
      "This looks like a game changer for {cat}.",
    ],
  },
  {
    id: "mobile",
    label: "Mobile experience",
    polarity: -1,
    keywords: ["mobile", "app", "ios", "android", "phone", "offline"],
    phrases: [
      "Is there a mobile app? I do most of my {cat} stuff on my phone.",
      "{c}'s mobile app is unusable. Whoever nails mobile wins.",
      "Needs to work offline. Spotty signal on my commute.",
    ],
    objection: "Needs a solid mobile app",
    answer: "Launch with mobile (or a great PWA) and show it in the hero video.",
  },
];

export function detectThemes(text: string): Theme[] {
  const t = text.toLowerCase();
  return THEMES.filter((th) => th.keywords.some((k) => t.includes(k)));
}
