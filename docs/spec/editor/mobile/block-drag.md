# Block drag

Moving a block by hand in the native editor (#311). The engine decides what a press lifts, where
it may land and the move ([portable-core block movement](../portable-core/block-movement.md));
the lines here are the gesture that names the position under the finger and the slot it lands on.

A long-press lifts a block only while the keyboard is down; while the note is being edited every
long-press is the platform's (#441). The keyboard counts as up whenever a text field of the note's
screen holds focus, so a hardware keyboard typing into the note counts too. The web editor asked
only whether its body had focus; here the title and Find fields count as well.

The gesture's lines are split by platform, and iOS's again in two, in their order; each page
states what its platform does.

- [iOS: lifting and the card](block-drag/ios-lift.md)
- [iOS: the move (preview, drop line, release, autoscroll, interruptions, haptics)](block-drag/ios-move.md)
- [Android](block-drag/android.md)
