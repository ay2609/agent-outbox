import { Fragment } from "react";
import { copyText, useToast } from "../ui";

// Prompts people paste into their own agent. Static on purpose: nothing here talks to the server.
// Each one names the tool, says what to personalise, and ends with the user approving. [Brackets] are for you to fill in.
interface Prompt { title: string; hint?: string; text: string }
interface Section { title: string; prompts: Prompt[] }

const SECTIONS: Section[] = [
  {
    title: "Text people",
    prompts: [
      {
        title: "Text one person",
        text: "Use agent-outbox to text [name]: [what you want to say]. Keep it short and in my voice, like a real text. Find them in my contacts first, and if more than one person matches, ask me which. Leave it as a draft for me to approve.",
      },
      {
        title: "Text several people, one by one",
        hint: "Each message is written for that person, not pasted.",
        text: "Use agent-outbox to draft a personalised message to each of [names]: [what to say]. Use a real detail about each person that you know from my contacts or from me, not just their name, and don't invent anything. Put them all in one batch, then tell me who you drafted for and who you skipped. I'll review and approve it.",
      },
    ],
  },
  {
    title: "From a file",
    prompts: [
      {
        title: "Message everyone in a spreadsheet",
        text: "Here's a spreadsheet: [path to the file]. Use agent-outbox to ingest it and check that the columns are mapped right (name, phone number or email). Then draft [what to say] to every row, using the other columns to make each message personal. Put them in one batch, and show me any rows you skipped and why. Leave everything for me to approve.",
      },
    ],
  },
  {
    title: "Contacts",
    prompts: [
      {
        title: "Add people to my contacts",
        text: "Add these people to my contacts with agent-outbox: [paste your list: one person per line, name and number or email]. Nothing is added until I approve it with Touch ID, so tell me who you drafted for my approval, who was already in my contacts, and anything you couldn't use.",
      },
      {
        title: "Make contacts from a file and save them as a group",
        text: "From [path to the file], use agent-outbox to make contacts and save them as the group '[Book club]'. People who are already in my contacts still go in the group; new contacts wait for my Touch ID approval. Show me any rows you couldn't use.",
      },
    ],
  },
  {
    title: "Groups",
    prompts: [
      {
        title: "Save people as a group",
        text: "Save [names] as the agent-outbox group '[group name]'. Look each person up in my contacts first, and ask me if a name matches more than one person.",
      },
      {
        title: "Invite a group",
        text: "Draft a personalised invite to everyone in my group '[group name]' with agent-outbox: [what, when, where, and how to reply]. Write each message separately, with a real detail about that person when you know one, and put them in one batch for me to review.",
      },
      {
        title: "Add people to a group",
        text: "Add [people] to my group '[group name]' with agent-outbox. Tell me who was added and who was already in it.",
      },
      {
        title: "Rename a group or remove someone",
        text: "Rename my agent-outbox group '[old name]' to '[new name]' and remove [name] from it. Then list the members so I can check.",
      },
    ],
  },
  {
    title: "Check on things",
    prompts: [
      {
        title: "What got sent",
        text: "What did agent-outbox send today, and did anything fail? Give me a short list: who, when, and what happened.",
      },
      {
        title: "What is waiting for me",
        text: "Which of my agent-outbox batches are still waiting for my approval? List each one with its title, how many messages it has, and its review link.",
      },
    ],
  },
];

/** Shows the [fill-in] parts in the accent colour; the copied text is the plain string. */
function PromptText({ text }: { text: string }) {
  return (
    <blockquote className="prompt" data-testid="prompt-text">
      {text.split(/(\[[^\]]+\])/).map((part, i) => (
        <Fragment key={i}>{part.startsWith("[") ? <span className="fill">{part}</span> : part}</Fragment>
      ))}
    </blockquote>
  );
}

export function AiDraft() {
  const toast = useToast();
  const copy = async (text: string) => { const ok = await copyText(text); toast(ok ? "Copied. Paste it into your agent." : "Copy failed.", ok ? "good" : "bad"); };
  return (
    <>
      <h1 className="page-title">AI draft</h1>
      <p className="muted">Paste one of these into Claude Code (or any agent with the agent-outbox tools). It drafts the messages; they appear in your Inbox and nothing sends until you approve with Touch ID.</p>
      <p className="small" data-testid="ai-pacing-tip"><strong>Big batch?</strong> With "Spread out messages" on in Settings, approved messages go out slowly, a few a minute, so a long list can take hours. Your agent can see that setting and tell you how long it will take.</p>
      <p className="fine">The agent has no agent-outbox tools? It can use the <code>outbox</code> command line instead: <code>bun run cli --help</code> in the agent-outbox folder.</p>
      {SECTIONS.map((s) => (
        <section className="section" key={s.title}>
          <h2 className="section-title">{s.title}</h2>
          <div className="stack">
            {s.prompts.map((p) => (
              <div className="card" key={p.title} data-testid="prompt-card">
                <div className="card-title">{p.title}</div>
                {p.hint && <div className="muted small">{p.hint}</div>}
                <PromptText text={p.text} />
                <button className="btn btn-small" onClick={() => copy(p.text)} data-testid="copy-prompt">Copy</button>
              </div>
            ))}
          </div>
        </section>
      ))}
      <p className="fine">Fill in the [bracketed] parts before you paste. Tips for agents: groups are saved lists of people (look one up by name with <code>outbox_get_group</code>, or list them with <code>outbox_list_groups</code>), and a personalised message per person beats one template.</p>
    </>
  );
}
