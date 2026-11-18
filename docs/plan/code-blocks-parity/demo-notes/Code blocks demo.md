```go name:server.go hl:4 ll:7
package main

import "net/http"
func handler(w http.ResponseWriter, r *http.Request) { w.Write([]byte("a response line long enough to wrap on a phone screen")) }
    // indented comment that is also long enough to wrap onto a second visual line here
func main() {
    http.HandleFunc("/", handler)
        http.ListenAndServe(":8080", nil)
}
```

A paragraph between blocks.

```python
print("language only")
```

```
no info string here
```

```js
const first = 1
```
```rust
let second = 2;
```

```
```

```txt hl:100-101
line 1
line 2
line 3
line 4
line 5
line 6
line 7
line 8
line 9
line 10
line 11
line 12
line 13
line 14
line 15
line 16
line 17
line 18
line 19
line 20
line 21
line 22
line 23
line 24
line 25
line 26
line 27
line 28
line 29
line 30
line 31
line 32
line 33
line 34
line 35
line 36
line 37
line 38
line 39
line 40
line 41
line 42
line 43
line 44
line 45
line 46
line 47
line 48
line 49
line 50
line 51
line 52
line 53
line 54
line 55
line 56
line 57
line 58
line 59
line 60
line 61
line 62
line 63
line 64
line 65
line 66
line 67
line 68
line 69
line 70
line 71
line 72
line 73
line 74
line 75
line 76
line 77
line 78
line 79
line 80
line 81
line 82
line 83
line 84
line 85
line 86
line 87
line 88
line 89
line 90
line 91
line 92
line 93
line 94
line 95
line 96
line 97
line 98
line 99
line 100
line 101
line 102
line 103
line 104
line 105
line 106
line 107
line 108
line 109
line 110
line 111
line 112
line 113
line 114
line 115
line 116
line 117
line 118
line 119
line 120
```

```kotlin name:a/very/long/path/to/the/source/file/Example.kt
fun long() = 1
```

- a list item
  ```sh
  echo in a list
  ```

> a quote
> ```sql
> select 1;
> ```

```yaml
last: block
```