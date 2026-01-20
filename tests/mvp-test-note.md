# GFM Syntax Test Note

This note tests all GitHub Flavored Markdown features.

## ATX Headings (1-6 levels)

# Heading 1
## Heading 2
### Heading 3
#### Heading 4
##### Heading 5
###### Heading 6

## Paragraphs and Line Breaks

This is a paragraph with
a soft line break (just a newline).

This paragraph ends with two spaces  
to create a hard line break.

This paragraph ends with a backslash\
to create a hard line break.

## Emphasis and Strong Emphasis

*italic with asterisks*
_italic with underscores_

**bold with asterisks**
__bold with underscores__

***bold and italic***
___bold and italic___

**bold with *nested italic* inside**

## Strikethrough (GFM Extension)

~~This text is struck through~~

~~strikethrough with **bold** inside~~

## Code Spans

Use `inline code` for short snippets.

Use ``backticks ` inside code`` with double backticks.

## Fenced Code Blocks

```
Plain fenced code block
no language specified
```

```javascript
// With language identifier
function hello() {
  console.log("Hello, world!");
}
```

~~~python
# Tildes also work
def hello():
    print("Hello, world!")
~~~

## Indented Code Blocks

    This is an indented code block.
    It requires 4 spaces of indentation.
    
    Blank lines are preserved.

## Block Quotes

> This is a block quote.
> It can span multiple lines.

> Block quotes can contain
>
> multiple paragraphs.

> Nested block quotes:
>
> > This is nested one level.
> >
> > > This is nested two levels.

> Block quotes can contain other elements:
>
> - Lists
> - **Bold text**
> - `code`

## Lists

### Unordered Lists

- Item with dash
- Another item
  - Nested item
  - Another nested item
    - Deeply nested

* Item with asterisk
* Another item

+ Item with plus
+ Another item

### Ordered Lists

1. First item
2. Second item
3. Third item
   4. Nested ordered
   5. Another nested

6. All items can use 1.
7. The renderer will number them
8. Correctly

9. Start at any number
10. And continue from there

### Mixed Lists

1. Ordered item
   - Unordered nested
   - Another unordered
2. Back to ordered
   3. Nested ordered
   4. Another nested

### Loose vs Tight Lists

- Tight list item 1
- Tight list item 2
- Tight list item 3

- Loose list item 1

- Loose list item 2

- Loose list item 3

## Task Lists (GFM Extension)

- [x] Completed task
- [x] Another completed task
- [ ] Incomplete task
- [ ] Another incomplete task

1. [x] Ordered task list
2. [ ] Also works with numbers

## Links

### Inline Links

[Basic link](https://example.com)

[Link with *emphasis*](https://example.com)

## Images

![Alt text](https://futo.org/images/authors/futologo.png "Image Title")

## Backslash Escapes

\*not italic\*

\`not code\`

\# not a heading

\[not a link\](https://example.com)

\- not a list item

\| not \| a \| table \|



## Edge Cases

### Empty Elements

> 

-
- 

### Nested Formatting

**bold *bold-italic* bold**

*italic **italic-bold** italic*


### Code in Lists

- Item with `inline code`
- Item with block:
  ```
  code block in list
  ```
