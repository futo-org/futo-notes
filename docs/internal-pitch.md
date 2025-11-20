This is an abridged/edited version of the pitch I made internally for FUTO Notes. Some things have changed slightly.

## Introduction - Why build a notes app?

A vision for FUTO that has stuck with me is Eron's idea that we should build a replacement for every app that comes preinstalled on phones. *Notes* is the app we should try to replace next.

Why?
### Vendor lock-in
Apple, Google, and many phone manufacturers ship their own notes app, often with a proprietary note format and sync engine. This creates lock-in. Most people don't know how to leave.
### Privacy
Notes can be extremely private - containing anything from our darkest thoughts to medical information and even passwords. While some services like Obsidian offer end-to-end encryption, others do not.

Apple has optional (opt-in) e2e encryption for notes. Google does not offer it.
### Obsidian is good, could be great
Obsidian is a good note taking app and the one I use currently. I like it. It does a lot of things right. But it could be better. The search is not very good, the UI a little too cluttered, and their "second brain" aspirations fall short.
### Beyond just notes
There was this craze for a while around "building a second brain". The basic idea was that by putting together all your notes and networking them using backlinks, you could build this beautiful graph and associate your thoughts together and 10x your creative ideas by combining concepts. Trevor says this is for people with no inner monologue.

I bought into it, briefly, despite having a rich inner life.

I got this out of it:

![](img/Pasted%20image%2020250911145843.png)
It looks cool! But it illustrates how infrequently I link things together. The vast majority of nodes are disconnected. You see that hyperconnected mass in the middle? That's from a history course I took on the making of the atomic bomb. I made separate notes for every lecture and for every important historical figure.

Was it helpful?

![](img/this-is-worthless-graph.jpg)

No. It's actually just gardening.

*There is an idea worth saving here.*

If you're using it daily, your notes app will contain valuable information and most notes app only act as a database for these notes. We can do better.
### How FUTO Notes could actually fulfill the "second brain" promise
Promise not to freak out.

AI. LLMs. Local Machine Learning. This is the way.

Google made the open web accessible to everyone when every other search engine was employing humans to categorize the web. We can do the same for people's personal repository of knowledge.

**I want to build the ML-augmented notes app for everyone.**

As I write this pitch, I should be able to look for things I've written on related subjects. I know for a fact I've written about software. But because I didn't tag it and I can't remember the exact name of the note, it is buried.
![](img/Pasted%20image%2020250916100224.png)

I don't want a graph of all my notes. I want better search. I want to be able to ask a question like "what are some best practices for building Android apps?" and get a straightforward answer that references my own thoughts and notes with citations. I want to be suggested past notes for sake of serendipity. I want to tell an LLM to fix my headings for me to all have the same capitalization structure.
## Core Principles
Before getting too far into features, let's lay down the core principles of this app.
### Snappy
Writing should feel good. There should be no noticeable input lag, even on older devices. I should be able to search with reasonable quickness.
### Self-hosting is a first-class citizen
You should not be penalized for self-hosting.
### You can leave at any time
No lock-in. You own your notes and they exist in a portable and accessible format.
### No distractions
Less is more. Do not get in the way of the user.
### AI, but not for the sake of AI
Every VC-backed startup is shouting "AI!! LLMs!" in their pitches and shoving AI wherever they see room. End-users shouldn't even have to think about AI. They should just have features that feel like magic. This is a continuation in using computers to connect knowledge, make smart suggestions, and be generally helpful.
### Data loss is punishable by death
If anyone loses personal data and it is our fault I will commit seppuku.

Not really. But you get the idea. Zero tolerance for data loss.
### Default aspirations
FUTO Notes should be approachable and attractive enough to be the default note taking app on the platforms it exists on.
## 1.0 Features
**Note: 1.0 is different from the MVP. This serves as a goalpost.**

FUTO Notes is a note-taking app focused on text. It uses markdown under the hood, but you don't have to think about that. It follows the [file over app](https://stephango.com/file-over-app) convention.

The basic layout is similar to Obsidian. On the left is your list of notes, on the right is the currently selected note. The editor itself is simple to use. Supports all the basic text manipulation stuff you would expect. It is written in markdown, but text decoration is applied in real-time. Images can be embedded. It's a pleasure to use even on older systems.

Search will go beyond just simple keyword matching in titles to actually searching for *meaning* through semantic search. If you are writing a note, there will be a way to easily find related notes.

We will offer a hosted syncing service, though you can bring a third party option like Syncthing or self-host.

The app should also have deep OS-level integration. Like home screen widgets for mobile. Easy installation on Linux. FUTO Notes should never feel like a "port". Even if we end up going with a cross-platform tech stack like Flutter, React Native, etc, there should be enough respect for the host platform that they don't *feel* like cross-platform apps.
## GTM Plan & Timeline
This is something I'd want to work out with Michael a bit more, but I thought I would share some initial thoughts.

In the beginning, especially before 1.0, we focus on our core audience, and that means focusing on Linux and Android. And if we had to pick one, Linux.

A **bare MVP** could launch without built-in sync and only on Linux. Depending on when this project can start, this would allow for a limited launch before FOSDEM '26 in February.
### Target Audience
As mentioned in Core Principles, FUTO Notes should be suitable to be a default notes app replacement. This means building something that appeals to a wide audience.

So our target audience will include knowledge workers, quick jotters, grocery listers, students, etc etc. It's actually probably easier to think about who we **don't** want to target.

We **aren't interested** in building a notes app for Microsoft Wordcels, visual/canvas note-takers, Notioners, or backlink enthusiasts.
### Platforms
Considering our audience and how notes are used, building a first-class desktop app should be the priority.

After that, Android. Then iOS. Perhaps simultaneously. Despite Android having about 70% of the mobile phone market, iOS constitutes about 70% of the revenue. [Source](https://www.tekrevol.com/blogs/android-vs-ios-statistics/).
### Timeline
I would like to have a deadline for some sort of launch.

As mentioned, FOSDEM could be a good deadline for a Linux client to be ready. I went in 2025 and would be happy to return in 2026. Dates for 2026 have not been announced.
## Early Thoughts on UI/UX, Inspiration
I want to spend some time exploring this space and I plan on working with a designer for final designs.

Obsidian's basic layout is pretty good. A little lifeless, though. Also, too many icons and panels.

![](img/Pasted%20image%2020250911160143.png)

I was also a big fan of the Bear app when I was a Mac guy. It has more personality while being simpler.
![](img/Pasted%20image%2020250911160218.png)

nvALT was my first introduction to using a bunch of text files as your notes database. It looks dated now (not updated since 2011), but it had some good ideas.
[nvALT](https://brettterpstra.com/projects/nvalt/) ![](img/Pasted%20image%2020250911110802.png)

Apple Notes is one of the nicer/easy to use notes apps. I don't like the organization aspect, but I do think it strikes a nice balance of power and simplicity.
![](img/Pasted%20image%2020250911160541.png)

Not a notes app, but one of my favorite apps ever is Things 3. Not only is it beautiful, but it feels at-home on a Mac. I love their iconography, too.

![](img/Pasted%20image%2020250911160740.png)

Not a piece of software, but I really like [teenage engineering's](https://teenage.engineering/) designs for hardware. [Example](https://teenage.engineering/store/ep-133):
![](img/Pasted%20image%2020250911160945.png)

Don't you want to press those buttons?

If we're to build a distraction free note-taking experience, typography will make up most of the design. By far the best typography I've seen in a note-taking app is [iA Writer](https://ia.net/writer). Their homepage has a great intro video.

![](img/Pasted%20image%2020250916102354.png)

They have a [full blog post](https://ia.net/topics/a-typographic-christmas) on their typography. I won't bore you with the details other than to say that this is something I'll put a lot of thought into.
## Tech Stack and Encryption
This will require a bit of exploration. I am researching and testing my options here.
### Platform Frameworks
Here are some of the options I am considering:
- [Tauri](https://v2.tauri.app/) for desktop
	- "Build your app for Linux, macOS, Windows, Android and iOS - all from a single codebase. Write your frontend in JavaScript, application logic in Rust, and integrate deep into the system with Swift and Kotlin."
	- Unlike Electron, it does not bundle the app with Chromium. Instead, it uses the system's webview. Smaller binaries, potentially better performance.
	- From my research, their mobile apps aren't mature yet
	- Using Javascript on the frontend means we get access to a lot of options for text editors
	- It also sets us up for a web version
	- **Why I like it:** I already know JavaScript for frontend. I want to learn Rust. Better performance than Electron. Hiring is easier. JavaScript has the best ecosystem for editors.
		- My main concern is maturity. Electron is much more widely used.
- [Electron](https://www.electronjs.org/) for desktop
	- "Build cross-platform desktop apps with JavaScript, HTML, and CSS"
	- This would be best for my own personal productivity - I know these technologies well and would not have to learn Rust/C++
	- Electron is mature and used by large apps like Slack
	- I have concerns around performance, but this needs to be tested.
	- VS Code uses Electron
	- **Why I don't want to use it:** Poorer performance compared to Tauri (need verification), especially on older Linux devices. Large binaries.
		- If Tauri does not work out, this is an option.
- [qt6](https://www.qt.io/) with C++ or Python
	- Cross-platform on desktop, more Linux-native than Tauri.
	- I am not familiar with using qt for frontend work
	- KDE uses Qt for [all of their apps](https://apps.kde.org/), some of which I use. They work well but look a little dated.
	- Licensing is slightly complicated, but not restrictive if I'm reading everything correctly
	- **Why I don't want to use it:** Not great on mobile. Slower frontend velocity. Harder to hire for.
- Flutter
	- Possibly bad performance on GPU-poor devices
	- Zulip expertise, though
	- **Why I don't want to use it:** I don't want to learn Dart.
- [Compose Multiplatform](https://www.jetbrains.com/compose-multiplatform/)
	- Seems like a less-mature, but more native-feeling alternative to Flutter
	- Write in Kotlin
	- **Why I don't want to use it:** Not great on iOS. Not mature.
- React Native
	- This is what FUTOcore used to build the Android app - I had a positive experience
	- Also capable of building desktop and web apps
	- Most mature
	- Easily paired with Electron or Tauri
	- **I kinda want to use it:** Good option if Tauri mobile does not pan out
- Pure native
	- This would mean Swift/SwiftUI on mac & iOS, Kotlin/Compose on Android, etc etc
	- **Why I don't want to use it:** Huge team needed. Feature parity would be difficult. Lower velocity.

I am vibe coding some basic implementations for a few of these just as proofs of concept, mostly to get a gauge on performance/feel. But for now, **I am leaning towards Tauri for desktop, then re-evaluating mobile once we are ready.**
### Version control, conflicts, RAG, ML, etc
All other aspects of the tech stack need further investigation. [Yjs](https://github.com/yjs/yjs) for version control/diffs seems interesting. All ML models will run locally. Embeddings with llama.cpp.
### Plugins??
Plugins are not a 1.0 feature, but something to consider for the future. I want to focus on building a good baseline app.

Many Obsidian plugins are open source and most of them seem to be MIT licensed.

What if FUTO Notes could use these plugins? We could make a curated set or auto-enable some of them. Or just have cross-compatibility.

Just an idea, not in scope for MVP.
### We probably shouldn't write our own text editor...
Zed is an excellent cross-platform IDE written in Rust. It's a pleasure to type in and very performant. But check out [the team page](https://zed.dev/team).

If we use something like Tauri, where the frontend is written in a JavaScript framework, there are many packages we can use as editors. Obsidian uses [CodeMirror 6](https://codemirror.net/). There are others like Blocksuite, TipTap, Lexical.dev, PlateJS, TinyMCE, etc.
### End-to-end encryption
Not necessarily a must-have at MVP launch. Need to work with Zack to determine how this fits in with Immich's needs.

Preferably, the sync engine that we use is the same that Immich uses. This means we build the sync engine to scale to different use-cases which will add complexity, but make it more robust.
### Self-Hosting
Self-hosting the sync server will be an option. Immich's approach to self-hosting seems to be working well - sell licenses to the server and make it easy to spin up as a Docker container.

There may be other ways we can make self-hosting even easier. For example, we could allow for people to enable sync directly from the desktop app and allow sync over the network as long as the app is up and running. Not an MVP feature.
### Machine Learning & AI Features
While not necessary for MVP, I do see real value in adding ML features to this app. Unlike other apps trying to do something similar, **all ML will be local**.

**Better search** - Obsidian has poor search performance, you have to get the keywords exactly right to find the note you're looking for. We could use semantic search so that users can search by *meaning*.

**Writing tools** - When writing an essay, I should be able to highlight a sentence and ask for help rewording it without leaving my editor, using local LLMs.

**Ask my notes** - search is one thing, but what if I could ask my notes a question? I have thousands of notes in Obsidian and would to ask things like: what are some of my oldest software project ideas? What gifts did I want to buy for mom? What was the name of that one tool that does X?

**Related notes** - I know for a fact that I've got notes about my approach to building software and products. I should be able to find notes that are similar to this one.
### Building for the web
We should have a web client as well. This opens up the app to be much more useful for collaboration features. For example, if Obsidian had a web app, I could easily share this document with you, dear reader, instead of using an intermediate format that is designed to be maximally compatible with printers.

Having a web app does push the Platform decision slightly more towards something like Tauri/Electron, since we'd be able to reuse the frontend.
## Team
Some of the tech stack decisions come down to team size.

**If it's just me**, I won't have time to manage all platforms + sync, so I would focus on making a really good desktop client and wait for Zack nail down e2e sync for Immich before recruiting him to adapt it for FUTO Notes.

**If it's me plus one dev (Morgan?),** I would have the other developer focus on getting sync working. This would free me up to work on more platforms.

I will work with a designer (likely Rueben) and DevOps (Kenny) as needed.

I do want to keep team size small until we see actual user growth.
## Naming
"FUTO Notes" is the obvious choice. Google has "Google Keep" - we shouldn't use "Keep", but I do like that "Keep" is a little more broad than "Notes". Something to think about. FUTO Brain? FUTO Recall? FUTO Drafts?

If the app gets too large people will call it FUTO Bloats. jsyk.
## Direction
I wanted to sketch out different directions we could take this as it evolves.
### Comprehensive Notes/Calendar/Todo/Productivity Suite
Think Notion, but better. We help you get work done.
### Integration with Zulip/Work apps
More of an enterprise play - build this into something that a business might purchase for their organization. FOSS Google Workspace. Notion-y, too.
### Publishing
Obsidian [does this already](https://obsidian.md/publish), but I think it's an interesting angle if we're interested in [saving the open web](https://www.theverge.com/news/773928/google-open-web-rapid-decline).
### Local LLM Hub
People are handing over their secrets to OpenAI, Google Gemini, Anthropic, etc in droves. This is problematic from a privacy perspective and it helps create lock-in as all your context lives in a walled garden.

If instead all your secrets were aggregated into a secure, portable location like FUTO Notes, you could run LLMs locally (or on our hosted LLM service, which would compete with [Proton's Lumo](https://proton.me/blog/lumo-ai)) to get the same results without the privacy nightmare.
## Pricing & Revenue
When I look at my FUTO IOUs, I think the profit target is more achievable for a project like this versus MAUs. So how does this make money?
### Platforms
Let's say [Lunduke](https://lunduke.locals.com/post/6020029/total-linux-desktop-pcs-now-over-56-million) is right and there's about 60 million PCs running Linux today. I would guess somewhere around 10% of those users are 1) in the market for a notes app and 2) would be willing to pay for it. In this scenario, our total addressable market is about 6 million users. This is a small market.

If we build our desktop app to be cross-platform, our market expands ~30x. Assuming a similar split, our total addressable market is about 200 million users.

And if we have iOS and Android apps, our market expands further - there are about [5.7 billion](https://datareportal.com/global-digital-overview?utm_source=chatgpt.com) phone users worldwide.

**FUTO Notes should be cross-platform**. Both from a practical and business perspective. Users expect their notes to be available everywhere. This greatly increases our surface area for new customers and exposes us to Apple platforms, which are historically the most profitable. Apple is also being forced to open up a bit more in both the US and EU, so we could avoid paying the 30% Apple tax.
### Pricing Model, Freemium
All client apps are free to download, we just ask that you purchase a license. Same with our server software.

I want to play around with offering paid features that are only unlocked after purchase. Custom themes, special fonts, anime girls, etc etc.

The sync service is something we charge for. For $5-15/month you get all text notes backed up plus up to X GB of rich media.

If you use our sync service, we can also let you log in on the web and edit your notes anywhere.

If the ML features gain considerable traction with our desktop users, we could start to offer hosted services for those without powerful GPUs at home. Syncing embeddings, generating text, and more powerful search could be offloaded to the cloud when needed. A service like this could be more profitable (and complex) than plain sync.
### Hardware
FUTO NAS starts to make more sense if we focus on creating a seamless experience for first-party services via a networked box.
## The Competition
A quick note on some competitors.
### Proprietary
#### [Obsidian](https://obsidian.md/)
Good UX and clear [philosophy](https://obsidian.md/about). A lot of fans in our community. But closed-source. Poor search. Available on all major platforms except web.
#### Apple Notes
Very easy to use, platform-level integration. Only on Apple platforms. Deep hardware <> software integration.
#### Google Keep Notes
I personally use this for grocery lists. No desktop apps.
#### Microsoft OneNote
Way too heavy. I have a general disdain for OneNote. Cross-platform, including web, but no Linux.
#### [Relfect](https://reflect.app/)
Leans very heavily into the AI stuff. Probably venture-backed.
#### [Roam Research](https://roamresearch.com/)
I was using this right before Obsidian. Pioneered the idea of linking notes. Focused on academics. Premium pricing. UI is quite bare. All platforms, including Linux & web.
![](img/Pasted%20image%2020250915113851.png)
#### [Mem.ai](https://get.mem.ai/)
I found this *after* coming up with my ideas for AI + notes. Looks like they had the same ideas, too. Would be good to test out.

Not e2e encrypted.

From my very brief testing, the UI seems good but I need to do more testing with the AI features. I would need to upload all my notes to truly test that but... I would rather not do that.
![](img/Pasted%20image%2020250915155617.png)
### Open Source
#### [Joplin Notes](https://joplinapp.org/)
UI is a bit too busy, but it does have a small but active [community](https://www.reddit.com/r/joplinapp/). Cross-platform. Offers a cloud service with E2EE.

Looking at the sponsors section tells me they aren't making a ton of money.
![](img/Pasted%20image%2020250915124326.png)

#### [LogSeq](https://logseq.com/)
Probably the closest to what we want to build. [Web-based live demo](https://demo.logseq.com/) available. They offer a pro service for syncing.

I do not like their Android app.
#### [Affine](https://affine.pro/)
Really well polished. Very popular on Github (sorry). Trying to be the OSS Notion. [Live demo](https://app.affine.pro) available. Chinese?
#### Other OSS options
- [Capacities](https://capacities.io/)
	- Michael found this - says it has good templating
- [Tangent Notes](https://www.tangentnotes.com/)
	- A fresh take on note taking itself
- [siyuan](https://github.com/siyuan-note/siyuan)
	- Very full-featured, Electron for desktop but fully native Android and iOS apps
- [Daino Notes](https://www.get-notes.com/)
	- More stripped down
	- Written with Qt 6 & C++
- [Superlist](https://www.superlist.com/)
	- More task focused
	- They publish their [Flutter-based editor](https://github.com/superlistapp/super_editor)
	- [Pricing](https://www.superlist.com/pricing)
- Notesnook
## Conclusion
I'm excited about this app. I want to build a smart, private notes app that anyone can use. The AI craze has already pushed out some "AI-first" notes apps, but nobody has really nailed the implementation yet. By focusing on private, local-first machine learning coupled with a damn good interface, I think we can build something special.
