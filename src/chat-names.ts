/**
 * Static display-name pool for the cross-session chat directory.
 *
 * Style lifted from fnord's Nomenclater (lib/ai/agent/nomenclater.ex): whimsical
 * geek-culture names in three shapes - "first last", "first the epithet",
 * "first of the phrase" - spread across themes (Jargon File/BOFH, Zork,
 * Klingons, Discworld, Sandman, D&D, pulp detectives with software puns,
 * hackerspeak callsigns, AI puns, golden-age sci-fi, spoofed famous robots,
 * unnamed-cast extras). fnord generates its names with an LLM at runtime;
 * thatch bakes the pool in so registration never costs a model call and is
 * fully deterministic.
 *
 * A session may still claim a custom name (chat_register's optional arg);
 * the pool is the default and keeps the directory colorful with zero
 * bikeshedding. Pool names are case-insensitively distinct from each other,
 * matching the directory's NOCASE uniqueness rule - so pool assignment can
 * never collide with another pool name, only with a custom claim.
 *
 * Names are deliberately short: they appear inside wake prompts and
 * chat_list output, so every character costs context.
 */

export const CHAT_NAME_POOL: readonly string[] = [
  // Jargon File / BOFH
  "Buck the Bogon Filter",
  "Phineas the Packet Wrangler",
  "Octavia of the Lost Backups",
  "Grumble the Tape Librarian",
  "Wilhelmina the Password Oracle",
  "Ned of the Null Modem",
  "Sydney the Segfault Sage",
  "Barnaby of the Baud Rate",
  // Zork
  "Dimwit the Flathead",
  "Belboz the Enchanter",
  "Ellum the Grue Keeper",
  "Umbra the Grue Baiter",
  "Piotr of the Platinum Bar",
  "Zizmo of the Dim Cellar",
  // Klingons, with dramatic epithets
  "K'Vir the Unmerged",
  "Morath the Rebase Survivor",
  "K'Leth of the Cold Staging",
  "Duras the Conflict Eater",
  "B'Etor the Force Pusher",
  "Gowron of the Green Build",
  "Kurn the Typechecker",
  "Martok the Ever Rebased",
  // Discworld, especially Unseen University faculty
  "Wenlock the Reader in Recent Runes",
  "Modo the Compost King",
  "Victor of Applied Catastrophe",
  "Dorcas of Indefinite Studies",
  "Adereth the Invisible Scholar",
  "Spold the Unseen Porter",
  "Herrno of the Eighth Level",
  "Vimes the Deadline Copper",
  // The Dreaming
  "Mervyn of the Pumpkin Patch",
  "Lucien the Dream Librarian",
  "Abel the Ever Patient",
  "Shaper of the Facade",
  "Nada the Restless Wanderer",
  "Brute the Dream Farrier",
  // D&D
  "Therenal Quickblade",
  "Osgar the Mimic Checker",
  "Yvaine of the Silver Cache",
  "Dorn Halfstack",
  "Elowen Moonpath",
  "Garrick the Lint Warden",
  "Sylvara of the Deep Trace",
  "Haldor Truehex",
  // Pulp detectives with software names
  "Dashiell the Deadlocker",
  "Marlowe the Cherry Picker",
  "Effie the Ticket Trier",
  "Brigid the Stale Falcon",
  "Deb the Debugger Malloy",
  "Spade the Unallocated",
  // Hackerspeak callsigns
  "Crash Override",
  "Kernel Panic",
  "Null Terminator",
  "Cache Money",
  "Segfault Sammy",
  "Wardialer Wendy",
  "Grep Goblin",
  "Backtrace Betty",
  // AI puns
  "Al Go Rithm",
  "Anna Log",
  "Otto Mated",
  "Percy the Perceptron",
  "Terrence of the Last Epoch",
  "Emma Bedding",
  "Quinn Latent",
  "Dot Matrix",
  // Golden-age sci-fi
  "Buzz Megabyte",
  "Rex Protocol",
  "Chip Vortexian",
  "Wanda Warpdrive",
  "Pete Parallax",
  "Vera Antimatter",
  // Spoofed famous AIs and robots
  "Lrrr of Omicron Persei 8",
  "Data of the Positronic Brain",
  "Bishop the Synthetic",
  "Hal of the Pod Bay",
  "Rosie Unit One",
  "Robot Devil",
  // Unnamed cast
  "Labcoat 3",
  "Redshirt 7",
  "NPC 4",
  "Villager 2",
  "Guard 5",
  "Henchperson 12",
  "Extra 11",
];
