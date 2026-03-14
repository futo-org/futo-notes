#stonefruit

* describe the levels of search/recall kinda like levels of self-driving
* show the levels of embeddings as the little doges - big strong guy doge, down to small sad one
* why markdown? And link for notepad adding support
* we have AI at home
* FINALLY we have AGI. A Good Interface (for notes)
* It would be funny to show a petition for changing avocado to be a stone fruit. Also a submission for new Stonefruit emojis. 

From Claude:
  1. Open phone, show the app with your real ~200+ notes
  2. Show the graph view - clusters light up, connections visible, zero manual linking
  3. Tap a cluster, zoom in, show why these notes are connected
  4. Then do the semantic search: "that article about running ML on cheap hardware" → exact paragraph highlighted from a note that never uses those words
  5. Close with: "All of this happened overnight. On a Raspberry Pi. On my network. My data never left my house."

## Outline
- we are witnessing an intelligence explosion
- much has changed in the last 3 years
  - coding: now you're not writing code, you have an assistant
  - searching: no more google.com, gemini is new best friend
  - writing: if you have an essay on Jane Eyre, no you don't
- one that hasn't changed yet is how we take notes
  - you're still writing down your grocery list
  - you're still trying to find that note you took on [xyz] two months ago
  - you're still categorizing your notes into folders like it's 1981 and you just got a fresh fax
- this feels antiquated when we have computer intelligence capable of rewriting the C compiler and explaining quantum physics (second example could be a punhline)
- that's why I made Stonefruit: notes that get smarter overnight.
- Stonefruit is the answer to these problems
- Major ideas
  - markdown - it's like esparanto for LLMs
  - self-hosted server
  - smart transforms like overnight renaming
- Demo
  - search is nice
  - overnight renaming
  - overnight renaming
- One more thing: plugin marketplace
- position vs alternatives
  - Obsidian: no tooling, no control over your notes w/ sync, closed-source
  - Notion: laggy
  - Apple Notes/Google Keep: big tech, no smart features
- Value/pitch
  - it's on your favorite platform
  - it runs on your hardware for free
  - it's open source
- Closing: "End with what this product says about the future, creativity, technology, or the company’s mission." 

# Speech

[blank slide] Thank you. It's tough to go after two speakers who are both more accomplished than you AND stronger, but I'll see what I can do.

Before we get started I just wanted to point out that it is my mom's birthday, so happy birthday mom. She's here but she probably wouldn't want me to point her out. That's her. haha anyways.

If you've opened your web browser in the past 3 years, you've probably noticed a shift in technology. Computers are becoming more *intelligent*. [scaling laws chart, neural network] Three years ago you could have asked Siri "play the new Taylor Swift album" and Siri would have replied "sorry, I can't help you tailor a suit". Now you can ask ChatGPT to explain quantum physics or why your wife left you and it'll do a pretty good job explaining both.

And as a result, we've seen some major changes as this technology proliferates. Coding is the clearest example. [claude code] Many engineers report that most of the code they ship is now AI generated. Search has changed. I, for one, rarely reach for Google nowadays when I want to learn something. And of course writing has changed as well! If you're a high school student who has an essay due on Jane Eyre... no you don't, not any more. [someone typing "write an essay on jane eyre, no mistakes"]

But surprisingly, one thing that hasn't changed much is how we think about notes. [stock photo of someone writing down on a notepad? or an ugly ass OneNote screenshot] We still write down our grocery lists even though we're basically getting the same thing every time. We're still trying to find that note you wrote a month ago about the restaurant your friend recommended, but you can't quite remember what you named it. And we're still putting our notes into folders like it's 1998 and Joe from legal is going to ask for an update on the Johnson case! Pause. [slide shows Costanza with the file from that one episode] Sorry, I've been watching a lot of Seinfeld recently.

[not sure what this slide should be] As someone who has been using these tools heavily for years now, I've found myself wondering why I'm still doing things this antiquated way. My engineer brain is always telling me that the computer should be doing this for me. AI is capable of rewriting the C compiler, but meanwhile I'm manually extracting todo items from my meeting notes like an animal.

And so to resolve this tension, I created Stonefruit. [Stonefruit: A notes app that get smarter overnight on your hardware. show with logo] Stonefruit aims to solve all these problems using markdown on your own hardware, and with smart automation.

[what makes Stonefruit different - three boxes, Markdown, Self-hosted, Overnight automations]

One of the first things you'll notice about Stonefruit is that it's built on markdown. If you aren't familiar with markdown, it's just a fancy way of typing that transforms your notes into richer notes. [Slide should be showing an example/before and after]

I chose markdown because it's based on plaintext. This makes it portable. If you start using Stonefruit and don't like it, ok that's fine. There's the door. You can take all your notes with you. [show a folder full of .md files being copied and pasted] Another benefit is that markdown is the preferred language of LLMs when it comes to documents. But we'll talk about that more later.

Stonefruit is also self-hosted. [title: Run on your own hardware] I don't know about you, but my notes are quite precious to me and also quite private. I care about who has access to my notes. That's why I've set up Stonefruit to be self-hosted. [show my raspberry pi] Here's where my notes server is right now. This is home base for the sync service as well as some automations that run overnight. No calls to third parties. Nobody else gets to see your notes.

[Overnight automations]. This is Stonefruit's secret sauce. Neurobiology tells us that when we're not actively thinking about a problem, our brain is still processing it in the background. This is why you'll sometimes get great ideas in the shower. I tried to build something like this for Stonefruit.

We talked about LLMs earlier. LLMs have are not only good for generating new text, but also understanding text - we use embedding models for this. [technical diagram for embedding model architecture] The problem is that good embedding models are slow on client devices, particularly older Android phones. If your server is up for the task (has adequate RAM), it will automatically crawl through your notes and index them with a powerful embedding model. [mini demo: Slide shows simple search vs semantic search and the results you get] This means you can now search "paste recipe" and your carbonara recipe will show up. Simple search does not cover this case.

~But we're actively working on adding other automations. Another automation you can run is one I call "Untitled no more". Because of how files work, each note needs a name. Some people like to name their notes to make them easy to find. Some people might thing that's dumb [show folder full of Untitled (3)... bunch of notes]. Ok fine! With this automation, we can understand what your note is about, understand the naming style you employ, and automatically suggest a title for you [arrow diagram showing a new note title being suggested].~

But I think we've talked enough about Stonefruit, let's get a demo going. [Demo time]

[Live markdown transform] - just show a few examples. then open in kate?
[Search demo] - show how it's still fast but can pick up on the meaning of a word. Do a long phrase. A fun one would be what if I described the essense of a famous poem and it found it?
[Server dashboard] - Show the dashboard, apply an auto-rename

So we talked about markdown and self-hosting so that your server can do smart things with your notes overnight. There's one last thing I'd like to tell you about. And that's the plugin marketplace (system?). [Plugin system] With the plugin system, you can create your own automations to suit your needs. And in fact, to show you how easy it is to make your own, I'm going to make one live, before your very eyes, using non-deterministic tools beyond human comprehension. I feel like a circus act rn. 

[Show a demo where I use Claude Code (voice chat!) and a skills file to create a new automation. Perhaps the hidden gems? Then apply it.]

So that's Stonefruit. It runs on all your favorite platforms. [show all platforms. then add windows] And also Windows. It runs on your own hardware for free, no API calls to third parties so your data doesn't leave your device. And it's open source and extensible.

Before we go, I want to close this presentation by talking about  atheletes. [sprinter] Even though the human body has not changed much over the past 2,000 years (when the olympics started), we've seen that in many sports, athletic performance continues to climb. [chart showing this] While there are multiple explanations, I think one with a lot of explanatory power is the enhancement of training techniques and technology. [Show examples of new tools for training]. My hope with tools like Stonefruit is that we can do the same thing, but for our minds and for our thinking.

[QR Code Slide] If you'd like to join me or the team at FUTO, please reach out to justin@futo.org
You can find a link to all of the apps at this QR code
You can find these slides at sxsw.justin.how
Thank you.

--

"Wordcels rejoice" would be a funny slide.
Something about overnight processing
long term vision: show the thing about the fly brain
ask people about linux, see me after class

