// Public copy for the whole site, ported from the mockup's shared content.js.

export interface Link {
  label: string;
  /** Absent for the email link: its address is assembled at runtime from `emailCode`. */
  href?: string;
  kind?: "email";
}

export interface NimbleSystem {
  id: "state" | "scheduling" | "assignment" | "rust" | "simulation";
  name: string;
  body: string;
}

export interface WorkItem {
  id: string;
  kind: string;
  title: string;
  org: string;
  years: string;
  pitch: string;
  points: string[];
  tags: string[];
  href: string | null;
}

export interface PathItem {
  years: string;
  what: string;
  where: string;
  href?: string;
}

export interface ResearchItem {
  title: string;
  kind: string;
  year: string;
  note?: string;
  href: string;
}

export interface OpenSourceItem {
  project: string;
  what: string;
  href: string;
  label: string;
}

export interface Topic {
  id: string;
  label: string;
  line: string;
}

export interface TopicGroup {
  name: string;
  topics: Topic[];
}

/** [mouse, touch] wording of a hint. */
export type Hint = [string, string];

/** Words used inside the Nimble stage: hints, controls, readouts and floor labels. */
export interface StageCopy {
  floorLabel: string;
  hints: Record<"floor" | NimbleSystem["id"], Hint>;
  addOrder: string;
  floor: { fleet: string; open: string; placed: string; clock: string; seed: string; generated: string };
  floorTags: { rack: string; station: string; robot: string; order: string };
  states: string[];
  stateNow: string;
  stateHeading: string;
  stateNext: string;
  stateOnItsWay: string;
  stateAlreadyHere: string;
  stateNotAllowed: string;
  tasks: string[];
  tasksLabel: string;
  schedNow: string;
  schedLater: string;
  schedOrder: string;
  schedWentTo: [string, string];
  assignWaiting: string;
  assignTravel: [string, string, string];
  subsystems: string[];
  python: string;
  rust: string;
  bus: string;
  migrateAll: string;
  reset: string;
  eventsPerSecond: string;
}

export interface Content {
  name: string;
  shortName: string;
  monogram: string;
  role: string;
  description: string;
  hero: { line: string; sub: string; illus: string; hint: string; hintTouch: string };
  links: Link[];
  nimble: {
    heading: string;
    org: string;
    role: string;
    years: string;
    intro: string;
    href: string;
    systems: NimbleSystem[];
    tags: string[];
    disclaimer: string;
    simTech: string;
    liveLabel: string;
    liveNote: string;
  };
  /** Variant E only: words inside the Nimble stage. */
  stage: StageCopy;
  projectsHeading: string;
  openSourceHeading: string;
  openSource: OpenSourceItem[];
  now: string[];
  work: WorkItem[];
  pathHeading: string;
  path: PathItem[];
  researchHeading: string;
  research: ResearchItem[];
  earlierLabel: string;
  earlier: string[];
  contactHeading: string;
  contact: string;
  talk: { sub: string; groups: TopicGroup[]; cta: string };
}

/**
 * The email address, character-shifted and reversed so it never appears in
 * plaintext in the source, the built HTML or the JS bundle. Decoded in the
 * browser by `decodeEmail` (src/scripts/email.ts).
 */
export const emailCode = "npd/mjbnhAbobiutb/jwtbitbz";

export const CONTENT: Content = {
  name: "Yashasvi Asthana",
  shortName: "Yashasvi",
  monogram: "YA",
  role: "Senior Software Engineer",
  description:
    "Yashasvi Asthana builds the software that decides who does what, and when: five years coordinating robot fleets at Nimble Robotics.",
  hero: {
    line: "I build the software that decides who does what, and when.",
    sub: "Five years coordinating robot fleets at Nimble Robotics, in Rust and Python. Always building what comes next: AI systems that run fast and stay on your own machine.",
    illus: "Illustrative simulation, not Nimble's software",
    hint: "Click the floor to place an order",
    hintTouch: "Tap the floor to place an order",
  },
  links: [
    { label: "GitHub", href: "https://github.com/YashasviAsthana" },
    { label: "LinkedIn", href: "https://www.linkedin.com/in/yashasvi-asthana/" },
    { label: "Email", kind: "email" },
  ],

  // The centerpiece: five years of production work at Nimble. Bodies stay close
  // to the approved resume bullets (shortening is fine, embellishing is not).
  nimble: {
    heading: "What I built at Nimble Robotics",
    org: "Nimble Robotics",
    role: "Senior Software Engineer",
    years: "Nov 2021 to now",
    intro:
      "I joined Nimble as an early engineer in 2021. Nimble runs fully autonomous fulfillment warehouses, where robots pick orders while they move on top of the storage grid. My work is the coordination layer: the software that decides what every robot does next. It runs at every production site.",
    href: "https://nimble.ai/",
    systems: [
      {
        id: "state",
        name: "Fleet and robot state machines",
        body: "What every robot, and the fleet as a whole, is doing right now and is allowed to do next.",
      },
      {
        id: "scheduling",
        name: "Task scheduling",
        body: "The layer that turns work into robot tasks, driving RL and heuristic control policies.",
      },
      {
        id: "assignment",
        name: "Order allocation and assignment",
        body: "Helped build order allocation and grouping, then implemented and optimized the assignment algorithm to cut the time to finish tasks and orders.",
      },
      {
        id: "rust",
        name: "Python to Rust",
        body: "A major contributor to moving core components to Rust, and nearly every subsystem to an event-driven architecture.",
      },
      {
        id: "simulation",
        name: "Full-system simulation",
        body: "Robot and operator mocks that run the entire system, many robots at once, on real and synthetic orders.",
      },
    ],
    tags: ["Rust", "Python", "Scheduling", "Event-driven", "Simulation"],
    // Required wherever a robot fleet, warehouse, or coordination visual appears
    // (user request, 2026-11-20). Keep it visible, close to the visual, and calm.
    disclaimer:
      "The fleet visuals on this page are illustrations written from scratch for this site, using textbook techniques. They are not derived from Nimble's software, algorithms, data, or warehouse layouts.",
    // After the disclaimer: how the simulation works.
    simTech: "The simulation uses space-time A* with a reservation table, in plain JavaScript.",
    liveLabel: "Live view of the floor above",
    liveNote: "Illustration, not Nimble's software",
  },

  // Variant E: the Nimble stage (ported from the A + D blend mockup). One short, quiet hint
  // per scene: what you can do, never what it means. The robot lifecycle, task
  // types and subsystems are generic, not any real product's.
  stage: {
    floorLabel: "Live view of the floor above",
    hints: {
      floor: ["Click the floor to place an order", "Tap the floor to place an order"],
      state: ["Click a state", "Tap a state"],
      scheduling: ["Click the chart to add an order", "Tap the chart to add an order"],
      assignment: ["Click to add an order, drag to move one", "Tap the floor to add an order"],
      rust: ["Click a subsystem to migrate it", "Tap a subsystem to migrate it"],
      simulation: ["Click the floor to add an order", "Tap the floor to add an order"],
    },
    addOrder: "Add order",
    floor: { fleet: "Fleet", open: "Open orders", placed: "Placed by you", clock: "Sim clock", seed: "Seed", generated: "Orders generated" },
    floorTags: { rack: "rack", station: "pick station", robot: "robot", order: "order" },
    states: ["Idle", "Assigned", "To pick", "Picking", "Carrying", "Dropping", "Charging"],
    stateNow: "Now ",
    stateHeading: "Heading to ",
    stateNext: ". Next:",
    stateOnItsWay: "on its way",
    stateAlreadyHere: "already here",
    stateNotAllowed: "not allowed from ",
    tasks: ["travel", "pick", "drop", "charge"],
    tasksLabel: "Task types",
    schedNow: "now",
    schedLater: "later",
    schedOrder: "order",
    schedWentTo: [" went to ", ", the first robot free."],
    assignWaiting: "waiting",
    assignTravel: ["Travel, illustrative: ", " first come, ", " re-solved"],
    subsystems: ["Orders", "Scheduler", "Assignment", "Robots", "Telemetry", "Simulation"],
    python: "Python",
    rust: "Rust",
    bus: "event bus",
    migrateAll: "Migrate all",
    reset: "Reset",
    eventsPerSecond: "Events per second, illustrative: ",
  },

  // Secondary: open source and side projects (everything in `work` except Nimble).
  projectsHeading: "Also building",

  // Open source: a quiet single line under "Also building", not a card.
  // The vLLM fix was small (user, 2026-11-20); it shows they contribute upstream,
  // so state it plainly and never inflate it.
  openSourceHeading: "Open source",
  openSource: [
    {
      project: "vLLM",
      what: "Merged a bug fix to the Rust frontend's chat template error handling",
      href: "https://github.com/vllm-project/vllm/pull/59020",
      label: "#59020",
    },
  ],

  // Not rendered on the current page (concept A has no Now section); kept for later.
  now: [
    "Contributing small fixes to open source AI tools",
    "Learning GPU performance from the ground up on my own hardware",
    "Local-first AI tools that keep your data on your machine",
  ],

  work: [
    {
      id: "nimble",
      kind: "Experience",
      title: "Multi-robot coordination",
      org: "Nimble Robotics",
      years: "Nov 2021 to now",
      pitch: "The layer that tells a production robot fleet what to do next.",
      points: [
        "Built the fleet and robot state machines and the task scheduling layer, driving RL and heuristic control policies.",
        "Major contributor to moving core components from Python to Rust and to an event-driven architecture.",
        "Implemented and optimized the order assignment algorithm to cut the time to complete tasks and orders.",
        "Built robot and operator mocks that run the whole system in simulation on real and synthetic orders.",
      ],
      tags: ["Rust", "Python", "Scheduling", "Simulation"],
      href: null,
    },
    {
      id: "hybrid-vision",
      kind: "Project",
      title: "hybrid-vision",
      org: "Rust, MCP",
      years: "2026",
      pitch: "A private, on-device screen memory that Claude or Cursor can search. No pixels leave your machine.",
      points: [],
      tags: ["Rust", "OCR", "Local-first"],
      href: "https://github.com/YashasviAsthana/hybrid-vision",
    },
    {
      id: "lanGen",
      kind: "Project",
      title: "lanGen",
      org: "Python",
      years: "2026",
      pitch: "One local AI assistant for every device on your Wi-Fi: chat, web search, images and video, all on your own GPU.",
      points: [],
      tags: ["Local LLMs", "Self-hosted"],
      href: "https://github.com/YashasviAsthana/lanGen",
    },
    {
      id: "mfmcp",
      kind: "Project",
      title: "mfmcp",
      org: "Python, MCP",
      years: "2026",
      pitch: "Portfolio analytics from a single statement PDF, as a CLI, a dashboard and an MCP server. Runs fully local.",
      points: [],
      tags: ["MCP", "Finance", "Local-first"],
      href: "https://github.com/YashasviAsthana/mfmcp",
    },
  ],

  pathHeading: "Path",
  path: [
    { years: "2015 to 2019", what: "BTech, Computer Science and Engineering", where: "Vellore Institute of Technology" },
    { years: "2018 to 2019", what: "Research assistant, air traffic controller workload", where: "VIT with the Airport Authority of India" },
    { years: "2019 to 2021", what: "MS, Computer Science and Engineering", where: "Penn State" },
    {
      years: "2020 to 2021",
      what: "Researcher, computer vision",
      where: "LPAC, Penn State Laboratory for Perception, Action, and Cognition",
      href: "https://sites.psu.edu/lpac/people/",
    },
    { years: "2020 to 2021", what: "Teaching assistant, Artificial Intelligence", where: "Penn State" },
    { years: "2021 to now", what: "Senior Software Engineer", where: "Nimble Robotics", href: "https://nimble.ai/" },
  ],

  // Linked, but quiet: a compact list near the path, not a feature.
  researchHeading: "Research",
  research: [
    {
      title: "Self-Supervised Recurring Pattern Discovery From A Single View",
      kind: "MS thesis, Penn State",
      year: "2021",
      note: "Advised by Yanxi Liu, LPAC",
      href: "https://etda.libraries.psu.edu/catalog/24533yxa150",
    },
    {
      title: "Novel 3D Scene Understanding Applications From Recurrence in a Single Image",
      kind: "Co-author, arXiv preprint",
      year: "2022",
      href: "https://arxiv.org/abs/2210.07991",
    },
  ],

  earlierLabel: "Earlier projects:",
  earlier: [
    "mmWave material sensing",
    "Foot-pressure pose classification",
    "fMRI cognitive state classification",
    "Causally consistent data centers",
    "Android chatbot",
  ],

  contactHeading: "Contact",
  contact: "Happy to talk shop. Or Dota.",

  // Rendered by src/scripts/topics.ts into [data-topics], under the contact line.
  // Each topic is a conversation starter; "Start here" opens an email with it as the subject.
  talk: {
    sub: "Scheduling, robot fleets, Rust, AI and computer vision are all fair game. So are Dota 2 and Rocket League, which I'd argue are coordination problems too.",
    groups: [
      {
        name: "Shop talk",
        topics: [
          { id: "scheduling", label: "Scheduling", line: "Who does what, and when. Ask me what happens when the plan meets reality." },
          { id: "fleets", label: "Robot fleets", line: "Five years of making many robots behave like one system, and I still find it fun." },
          {
            id: "rust",
            label: "Rust",
            line: "Moving hot paths from Python to Rust: what got faster, what got simpler, and what I'd do differently.",
          },
          {
            id: "ai",
            label: "AI and computer vision",
            line: "Where I started: finding repeated patterns in a single image at Penn State's LPAC lab. Where I'm headed: AI that runs fast on your own machine.",
          },
        ],
      },
      {
        name: "Off the clock",
        topics: [
          {
            id: "dota",
            label: "Dota 2",
            line: "Farm priority is an assignment problem. Five heroes, limited gold, and everyone thinks they're the carry.",
          },
          {
            id: "rocket-league",
            label: "Rocket League",
            line: "Rotations are fleet coordination with rocket boosts: one challenges, one supports, one covers the net.",
          },
        ],
      },
    ],
    cta: "Start here",
  },
};

export const SITE = {
  url: "https://yashasviasthana.github.io/",
  ogImage: "https://yashasviasthana.github.io/og.png",
  ogAlt: "Yashasvi Asthana. I build the software that decides who does what, and when.",
  themeColor: "#0A0F24",
};
