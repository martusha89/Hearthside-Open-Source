/**
 * Hearthside: one-click connectors. Each is the service's own hosted MCP server;
 * every address and sign-in method was checked against the live server. "signin"
 * opens the browser; "none" needs no account; "token" asks for an access token.
 */

export type CatalogEntry = {
  id: string;
  name: string;
  url: string;
  description: string;
  category: string;
  auth: "signin" | "none" | "token";
  /** Logo key in brand-icons (defaults to id). */
  brand?: string;
  /** Where to make a token, for "token" entries. */
  tokenHelp?: string;
};

export const CATEGORIES = ["Everyday", "Get things done", "Creative", "Look things up", "Developers", "Business"] as const;

export const CATALOG: CatalogEntry[] = [
  // Everyday
  { id: "notion", name: "Notion", url: "https://mcp.notion.com/mcp", description: "Journals, shared notes and plans.", category: "Everyday", auth: "signin" },
  { id: "todoist", name: "Todoist", url: "https://ai.todoist.net/mcp", description: "A to-do list your agent can read and add to.", category: "Everyday", auth: "signin" },
  { id: "strava", name: "Strava", url: "https://mcp.strava.com/mcp", description: "Your runs, rides and walks.", category: "Everyday", auth: "signin" },
  { id: "dropbox", name: "Dropbox", url: "https://mcp.dropbox.com/mcp", description: "Find and read your files.", category: "Everyday", auth: "signin" },
  { id: "airtable", name: "Airtable", url: "https://mcp.airtable.com/mcp", description: "Your bases: trackers, lists, collections.", category: "Everyday", auth: "signin" },
  { id: "granola", name: "Granola", url: "https://mcp.granola.ai/mcp", description: "Your meeting notes.", category: "Everyday", auth: "signin" },
  { id: "fireflies", name: "Fireflies", url: "https://api.fireflies.ai/mcp", description: "Meeting recordings and transcripts.", category: "Everyday", auth: "signin" },
  // Get things done
  { id: "asana", name: "Asana", url: "https://mcp.asana.com/sse", description: "Tasks and projects.", category: "Get things done", auth: "signin" },
  { id: "clickup", name: "ClickUp", url: "https://mcp.clickup.com/mcp", description: "Tasks, docs and goals.", category: "Get things done", auth: "signin" },
  { id: "monday", name: "monday.com", url: "https://mcp.monday.com/mcp", description: "Boards and work items.", category: "Get things done", auth: "signin" },
  { id: "linear", name: "Linear", url: "https://mcp.linear.app/mcp", description: "Issues and projects.", category: "Get things done", auth: "signin" },
  { id: "atlassian", name: "Jira & Confluence", url: "https://mcp.atlassian.com/v1/mcp", description: "Atlassian issues and pages.", category: "Get things done", auth: "signin" },
  // Creative
  { id: "canva", name: "Canva", url: "https://mcp.canva.com/mcp", description: "Find and make designs.", category: "Creative", auth: "signin" },
  { id: "figma", name: "Figma", url: "https://mcp.figma.com/mcp", description: "Read designs and files.", category: "Creative", auth: "signin" },
  { id: "miro", name: "Miro", url: "https://mcp.miro.com/", description: "Whiteboards and boards.", category: "Creative", auth: "signin" },
  { id: "webflow", name: "Webflow", url: "https://mcp.webflow.com/mcp", description: "Your Webflow sites.", category: "Creative", auth: "signin" },
  { id: "wix", name: "Wix", url: "https://mcp.wix.com/sse", description: "Your Wix sites.", category: "Creative", auth: "signin" },
  { id: "cloudinary", name: "Cloudinary", url: "https://asset-management.mcp.cloudinary.com/sse", description: "Your images and videos.", category: "Creative", auth: "signin" },
  // Look things up (no account)
  { id: "exa", name: "Exa", url: "https://mcp.exa.ai/mcp", description: "Web search.", category: "Look things up", auth: "none" },
  { id: "huggingface", name: "Hugging Face", url: "https://huggingface.co/mcp", description: "AI models, datasets and Spaces.", category: "Look things up", auth: "none" },
  { id: "context7", name: "Context7", url: "https://mcp.context7.com/mcp", description: "Up-to-date docs for code libraries.", category: "Look things up", auth: "none" },
  { id: "deepwiki", name: "DeepWiki", url: "https://mcp.deepwiki.com/mcp", description: "Explains any GitHub project.", category: "Look things up", auth: "none" },
  { id: "cloudflare-docs", name: "Cloudflare Docs", url: "https://docs.mcp.cloudflare.com/mcp", description: "Cloudflare's documentation.", category: "Look things up", auth: "none", brand: "cloudflare" },
  // Developers
  { id: "github", name: "GitHub", url: "https://api.githubcopilot.com/mcp/", description: "Repos, issues and pull requests.", category: "Developers", auth: "token", tokenHelp: "https://github.com/settings/personal-access-tokens/new" },
  { id: "sentry", name: "Sentry", url: "https://mcp.sentry.dev/mcp", description: "Errors and issues.", category: "Developers", auth: "signin" },
  { id: "vercel", name: "Vercel", url: "https://mcp.vercel.com", description: "Projects and deployments.", category: "Developers", auth: "signin" },
  { id: "netlify", name: "Netlify", url: "https://netlify-mcp.netlify.app/mcp", description: "Sites and deploys.", category: "Developers", auth: "signin" },
  { id: "supabase", name: "Supabase", url: "https://mcp.supabase.com/mcp", description: "Databases and projects.", category: "Developers", auth: "signin" },
  { id: "neon", name: "Neon", url: "https://mcp.neon.tech/mcp", description: "Postgres databases.", category: "Developers", auth: "signin" },
  // Business
  { id: "stripe", name: "Stripe", url: "https://mcp.stripe.com", description: "Payments and customers.", category: "Business", auth: "signin" },
  { id: "paypal", name: "PayPal", url: "https://mcp.paypal.com/mcp", description: "Invoices and transactions.", category: "Business", auth: "signin" },
  { id: "square", name: "Square", url: "https://mcp.squareup.com/sse", description: "Sales, items and customers.", category: "Business", auth: "signin" },
  { id: "intercom", name: "Intercom", url: "https://mcp.intercom.com/mcp", description: "Customer conversations.", category: "Business", auth: "signin" },
];
