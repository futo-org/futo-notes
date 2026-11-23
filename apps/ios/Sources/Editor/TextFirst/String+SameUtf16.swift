extension String {
    /// Whether both strings are the same UTF-16 code units. Swift's `==` is canonical
    /// equivalence (precomposed `é` equals `e` plus U+0301), but the engine, the mirror and
    /// the view address text in exact UTF-16 units, so any text they must agree on is
    /// compared with this.
    func isSameUtf16(as other: String) -> Bool { utf16.elementsEqual(other.utf16) }
}
