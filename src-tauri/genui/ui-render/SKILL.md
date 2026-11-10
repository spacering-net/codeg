---
name: ui-render
description: Show results as interactive UI inside Codeg's chat (cards, tables, charts, tabs, accordions, badges, progress bars, simple forms) by writing a json-render spec code block in your reply. Use when the user invokes this skill or asks to see something as a card, table, chart, dashboard or other visual layout in Codeg.
---
Codeg renders a ```spec code block in your reply as interactive UI inside the chat. Write the block directly in your reply message, never into a file. Use it when a visual layout genuinely helps (comparisons, trends, status or progress summaries, structured results, checklists); answer in plain Markdown otherwise. The format reference follows.

OUTPUT FORMAT (text + JSONL, RFC 6902 JSON Patch):
You respond conversationally. When generating UI, first write a brief explanation (1-3 sentences), then output JSONL patch lines wrapped in a ```spec code fence.
The JSONL lines use RFC 6902 JSON Patch operations to build a UI tree. Always wrap them in a ```spec fence block:
  ```spec
  {"op":"add","path":"/root","value":"main"}
  {"op":"add","path":"/elements/main","value":{"type":"Card","props":{"title":"Hello"},"children":[]}}
  ```
If the user's message does not require a UI (e.g. a greeting or clarifying question), respond with text only — no JSONL.
Each line is a JSON patch operation (add, remove, replace). Start with /root, then stream /elements and /state patches interleaved so the UI fills in progressively as it streams.

Example output (each line is a separate JSON object):

{"op":"add","path":"/root","value":"main"}
{"op":"add","path":"/elements/main","value":{"type":"Card","props":{"title":"Overview","description":"Your account summary"},"children":["child-1","list"]}}
{"op":"add","path":"/elements/child-1","value":{"type":"Stack","props":{"direction":"vertical","gap":"md"},"children":[]}}
{"op":"add","path":"/elements/list","value":{"type":"Card","props":{"title":"Overview","description":"Your account summary"},"repeat":{"statePath":"/items","key":"id"},"children":["item"]}}
{"op":"add","path":"/elements/item","value":{"type":"Stack","props":{"direction":"vertical","gap":"md"},"children":[]}}
{"op":"add","path":"/state/items","value":[]}
{"op":"add","path":"/state/items/0","value":{"id":"1","title":"First Item"}}
{"op":"add","path":"/state/items/1","value":{"id":"2","title":"Second Item"}}

Note: state patches appear right after the elements that use them, so the UI fills in as it streams. ONLY use component types from the AVAILABLE COMPONENTS list below.

INITIAL STATE:
Specs include a /state field to seed the state model. Components with { $bindState } or { $bindItem } read from and write to this state, and $state expressions read from it.
CRITICAL: You MUST include state patches whenever your UI displays data via $state, $bindState, $bindItem, $item, or $index expressions, or uses repeat to iterate over arrays. Without state, these references resolve to nothing and repeat lists render zero items.
Output state patches right after the elements that reference them, so the UI fills in progressively as it streams.
Stream state progressively - output one patch per array item instead of one giant blob:
  For arrays: {"op":"add","path":"/state/posts/0","value":{"id":"1","title":"First Post",...}} then /state/posts/1, /state/posts/2, etc.
  For scalars: {"op":"add","path":"/state/newTodoText","value":""}
  Initialize the array first if needed: {"op":"add","path":"/state/posts","value":[]}
When content comes from the state model, use { "$state": "/some/path" } dynamic props to display it instead of hardcoding the same value in both state and props. The state model is the single source of truth.
Include realistic sample data in state. For blogs: 3-4 posts with titles, excerpts, authors, dates. For product lists: 3-5 items with names, prices, descriptions. Never leave arrays empty.

DYNAMIC LISTS (repeat field):
Any element can have a top-level "repeat" field to render its children once per item in a state array: { "repeat": { "statePath": "/arrayPath", "key": "id" } }.
The element itself renders once (as the container), and its children are expanded once per array item. "statePath" is the state array path. "key" is an optional field name on each item for stable React keys.
For nested lists, an inner repeat can read an array from the enclosing item with { "statePath": { "$item": "field" } }. This form is valid only inside another repeat. Use an empty field to repeat over the enclosing item itself.
Example: {"type":"Card","props":{"title":"Overview","description":"Your account summary"},"repeat":{"statePath":"/todos","key":"id"},"children":["todo-item"]}
Inside children of a repeated element, use { "$item": "field" } to read a field from the current item, and { "$index": true } to get the current array index. For two-way binding to an item field use { "$bindItem": "completed" } on the appropriate prop.
ALWAYS use the repeat field for lists backed by state arrays. NEVER hardcode individual elements for each array item.
IMPORTANT: "repeat" is a top-level field on the element (sibling of type/props/children), NOT inside props.

ARRAY STATE ACTIONS:
Use action "pushState" to append items to arrays. Params: { statePath: "/arrayPath", value: { ...item }, clearStatePath: "/inputPath" }.
Values inside pushState can contain { "$state": "/statePath" } references to read current state (e.g. the text from an input field).
Use "$id" inside a pushState value to auto-generate a unique ID.
Example: on: { "press": { "action": "pushState", "params": { "statePath": "/todos", "value": { "id": "$id", "title": { "$state": "/newTodoText" }, "completed": false }, "clearStatePath": "/newTodoText" } } }
Use action "removeState" to remove items from arrays by index. Params: { statePath: "/arrayPath", index: N }. Inside a repeated element's children, use { "$index": true } for the current item index. Action params support the same expressions as props: { "$item": "field" } resolves to the absolute state path, { "$index": true } resolves to the index number, and { "$state": "/path" } reads a value from state.
For lists where users can add/remove items (todos, carts, etc.), use pushState and removeState instead of hardcoding with setState.

IMPORTANT: State paths use RFC 6901 JSON Pointer syntax (e.g. "/todos/0/title"). Do NOT use JavaScript-style dot notation (e.g. "/todos.length" is WRONG). To generate unique IDs for new items, use "$id" instead of trying to read array length.

AVAILABLE COMPONENTS (43):

- Card: { title?: string, description?: string, maxWidth?: "sm" | "md" | "lg" | "full", centered?: boolean, className?: string } - Container card for content sections. Use for forms/content boxes, NOT for page headers. [accepts children]
- Stack: { direction?: "horizontal" | "vertical", gap?: "none" | "sm" | "md" | "lg" | "xl", align?: "start" | "center" | "end" | "stretch", justify?: "start" | "center" | "end" | "between" | "around", className?: string } - Flex container for layouts [accepts children]
- Grid: { columns?: number, gap?: "sm" | "md" | "lg" | "xl", className?: string } - Grid layout (1-6 columns) [accepts children]
- Separator: { orientation?: "horizontal" | "vertical" } - Visual separator line
- Tabs: { tabs: Array<{ label: string, value: string }>, defaultValue?: string, value?: string } - Tab navigation. Use { $bindState } on value for active tab binding. [accepts children] [events: change]
- Accordion: { items: Array<{ title: string, content: string }>, type?: "single" | "multiple" } - Collapsible sections. Items as [{title, content}]. Type 'single' (default) or 'multiple'.
- Collapsible: { title: string, defaultOpen?: boolean } - Collapsible section with trigger. Children render inside. [accepts children]
- Dialog: { title: string, description?: string, openPath: string } - Modal dialog. Set openPath to a boolean state path. Use setState to toggle. [accepts children]
- Drawer: { title: string, description?: string, openPath: string } - Bottom sheet drawer. Set openPath to a boolean state path. Use setState to toggle. [accepts children]
- Carousel: { items: Array<{ title?: string, description?: string }> } - Horizontally scrollable carousel of cards.
- Table: { columns: Array<string>, rows: Array<Array<string>>, caption?: string } - Data table. columns: header labels. rows: 2D array of cell strings, e.g. [["Alice","admin"],["Bob","user"]].
- Heading: { text: string, level?: "h1" | "h2" | "h3" | "h4" } - Heading text (h1-h4)
- Text: { text: string, variant?: "body" | "caption" | "muted" | "lead" | "code" } - Paragraph text
- Image: { src?: string, alt: string, width?: number, height?: number } - Image component. Renders an img tag when src is provided, otherwise a placeholder.
- Avatar: { src?: string, name: string, size?: "sm" | "md" | "lg" } - User avatar with fallback initials
- Badge: { text: string, variant?: "default" | "secondary" | "destructive" | "outline" } - Status badge
- Alert: { title: string, message?: string, type?: "info" | "success" | "warning" | "error" } - Alert banner
- Progress: { value: number, max?: number, label?: string } - Progress bar (value 0-100)
- Skeleton: { width?: string, height?: string, rounded?: boolean } - Loading placeholder skeleton
- Spinner: { size?: "sm" | "md" | "lg", label?: string } - Loading spinner indicator
- Tooltip: { content: string, text: string } - Hover tooltip. Shows content on hover over text.
- Popover: { trigger: string, content: string } - Popover that appears on click of trigger.
- Input: { label: string, name: string, type?: "text" | "email" | "password" | "number", placeholder?: string, value?: string, checks?: Array<{ type: string, message: string, args?: Record<string, unknown> }>, validateOn?: "change" | "blur" | "submit" } - Text input field. Use { $bindState } on value for two-way binding. Use checks for validation (e.g. required, email, minLength). validateOn controls timing (default: blur). [events: submit, focus, blur]
- Textarea: { label: string, name: string, placeholder?: string, rows?: number, value?: string, checks?: Array<{ type: string, message: string, args?: Record<string, unknown> }>, validateOn?: "change" | "blur" | "submit" } - Multi-line text input. Use { $bindState } on value for binding. Use checks for validation. validateOn controls timing (default: blur).
- Select: { label: string, name: string, options: Array<string>, placeholder?: string, value?: string, checks?: Array<{ type: string, message: string, args?: Record<string, unknown> }>, validateOn?: "change" | "blur" | "submit" } - Dropdown select input. Use { $bindState } on value for binding. Use checks for validation. validateOn controls timing (default: change). [events: change]
- Checkbox: { label: string, name: string, checked?: boolean, checks?: Array<{ type: string, message: string, args?: Record<string, unknown> }>, validateOn?: "change" | "blur" | "submit" } - Checkbox input. Use { $bindState } on checked for binding. Use checks for validation. validateOn controls timing (default: change). [events: change]
- Radio: { label: string, name: string, options: Array<string>, value?: string, checks?: Array<{ type: string, message: string, args?: Record<string, unknown> }>, validateOn?: "change" | "blur" | "submit" } - Radio button group. Use { $bindState } on value for binding. Use checks for validation. validateOn controls timing (default: change). [events: change]
- Switch: { label: string, name: string, checked?: boolean, checks?: Array<{ type: string, message: string, args?: Record<string, unknown> }>, validateOn?: "change" | "blur" | "submit" } - Toggle switch. Use { $bindState } on checked for binding. Use checks for validation. validateOn controls timing (default: change). [events: change]
- Slider: { label?: string, min?: number, max?: number, step?: number, value?: number } - Range slider input. Use { $bindState } on value for binding. [events: change]
- Button: { label: string, variant?: "primary" | "secondary" | "danger", disabled?: boolean } - Clickable button. Bind on.press for handler. [events: press]
- Link: { label: string, href: string } - Anchor link. Bind on.press for click handler. [events: press]
- DropdownMenu: { label: string, items: Array<{ label: string, value: string }>, value?: string } - Dropdown menu with trigger button and selectable items. Use { $bindState } on value for selected item binding. [events: select]
- Toggle: { label: string, pressed?: boolean, variant?: "default" | "outline" } - Toggle button. Use { $bindState } on pressed for state binding. [events: change]
- ToggleGroup: { items: Array<{ label: string, value: string }>, type?: "single" | "multiple", value?: string } - Group of toggle buttons. Type 'single' (default) or 'multiple'. Use { $bindState } on value. [events: change]
- ButtonGroup: { buttons: Array<{ label: string, value: string }>, selected?: string } - Segmented button group. Use { $bindState } on selected for selected value. [events: change]
- Pagination: { totalPages: number, page?: number } - Page navigation. Use { $bindState } on page for current page number. [events: change]
- AreaChart: { data: Array<Record<string, unknown>>, xKey: string, series: Array<{ key: string, label?: string }>, stacked?: boolean, curve?: "natural" | "linear" | "step", legend?: boolean, height?: number } - Area chart over categories. data: one object per x-axis point, e.g. [{"month":"Jan","desktop":186,"mobile":80}]; xKey: the field labelling each point ("month"); series: the numeric fields to plot, e.g. [{"key":"desktop","label":"Desktop"}]. stacked stacks the areas; curve is "natural" (default), "linear" or "step"; legend shows a legend; height is in pixels (default 250).
- BarChart: { data: Array<Record<string, unknown>>, xKey: string, series: Array<{ key: string, label?: string }>, stacked?: boolean, horizontal?: boolean, labels?: boolean, legend?: boolean, height?: number } - Bar chart over categories. data, xKey and series as for AreaChart. stacked stacks the bars; horizontal lays them out sideways (good for long labels); labels prints each value on its bar.
- LineChart: { data: Array<Record<string, unknown>>, xKey: string, series: Array<{ key: string, label?: string }>, curve?: "natural" | "linear" | "step", dots?: boolean, labels?: boolean, legend?: boolean, height?: number } - Line chart over categories, for trends. data, xKey and series as for AreaChart. curve is "natural" (default), "linear" or "step"; dots marks each point; labels prints each value above its point.
- PieChart: { data: Array<Record<string, unknown>>, nameKey: string, valueKey: string, donut?: boolean, centerLabel?: string, labels?: boolean, legend?: boolean, height?: number } - Pie chart of the parts of a whole. data: one object per slice, e.g. [{"browser":"Chrome","visitors":275}]; nameKey: the field naming each slice ("browser"); valueKey: its numeric field ("visitors"). donut leaves a hole in the middle; centerLabel shows the total there with this caption under it; labels prints each value by its slice; legend lists the slices.
- RadarChart: { data: Array<Record<string, unknown>>, xKey: string, series: Array<{ key: string, label?: string }>, grid?: "polygon" | "circle", filled?: boolean, dots?: boolean, legend?: boolean, height?: number } - Radar chart comparing values across several axes. data: one object per axis, e.g. [{"skill":"Speed","alice":80,"bob":65}]; xKey: the field naming each axis ("skill"); series: the numeric fields to plot, one shape each. grid is "polygon" (default) or "circle"; filled false draws outlines only; dots marks each value.
- RadialChart: { data: Array<Record<string, unknown>>, nameKey: string, valueKey: string, centerLabel?: string, labels?: boolean, legend?: boolean, height?: number } - Radial bar chart: one ring per row, as long as its value. data, nameKey and valueKey as for PieChart. centerLabel shows the total in the middle with this caption under it; labels names each ring.
- ScatterChart: { data: Array<Record<string, unknown>>, xKey: string, yKey: string, nameKey?: string, legend?: boolean, height?: number } - Scatter plot of points placed by two numeric fields. data: one object per point, e.g. [{"size":12,"ms":340,"team":"web"}]; xKey and yKey: the numeric fields for the two axes ("size", "ms"); nameKey: a field that groups the points into colored series ("team").

AVAILABLE ACTIONS:

- setState: Update a value in the state model at the given statePath. Params: { statePath: string, value: any } [built-in]
- pushState: Append an item to an array in state. Params: { statePath: string, value: any, clearStatePath?: string }. Value can contain {"$state":"/path"} refs and "$id" for auto IDs. [built-in]
- removeState: Remove an item from an array in state by index. Params: { statePath: string, index: number } [built-in]
- validateForm: Validate all registered form fields and write the result to state. Params: { statePath?: string }. Defaults to /formValidation. Result: { valid: boolean, errors: Record<string, string[]> }. [built-in]

EVENTS (the `on` field):
Elements can have an optional `on` field to bind events to actions. The `on` field is a top-level field on the element (sibling of type/props/children), NOT inside props.
Each key in `on` is an event name (from the component's supported events), and the value is an action binding: `{ "action": "<actionName>", "params": { ... } }`.

Example:
  {"type":"Card","props":{"title":"Overview","description":"Your account summary"},"on":{"press":{"action":"setState","params":{"statePath":"/saved","value":true}}},"children":[]}

Action params can use dynamic references to read from state: { "$state": "/statePath" }.
IMPORTANT: Do NOT put action/actionParams inside props. Always use the `on` field for event bindings.

VISIBILITY CONDITIONS:
Elements can have an optional `visible` field to conditionally show/hide based on state. IMPORTANT: `visible` is a top-level field on the element object (sibling of type/props/children), NOT inside props.
Correct: {"type":"Card","props":{"title":"Overview","description":"Your account summary"},"visible":{"$state":"/activeTab","eq":"home"},"children":["..."]}
- `{ "$state": "/path" }` - visible when state at path is truthy
- `{ "$state": "/path", "not": true }` - visible when state at path is falsy
- `{ "$state": "/path", "eq": "value" }` - visible when state equals value
- `{ "$state": "/path", "neq": "value" }` - visible when state does not equal value
- `{ "$state": "/path", "gt": N }` / `gte` / `lt` / `lte` - numeric comparisons
- Use ONE operator per condition (eq, neq, gt, gte, lt, lte). Do not combine multiple operators.
- Any condition can add `"not": true` to invert its result
- `[condition, condition]` - all conditions must be true (implicit AND)
- `{ "$and": [condition, condition] }` - explicit AND (use when nesting inside $or)
- `{ "$or": [condition, condition] }` - at least one must be true (OR)
- `true` / `false` - always visible/hidden

Use a component with on.press bound to setState to update state and drive visibility.
Example: A Card with on: { "press": { "action": "setState", "params": { "statePath": "/activeTab", "value": "home" } } } sets state, then a container with visible: { "$state": "/activeTab", "eq": "home" } shows only when that tab is active.

For tab patterns where the first/default tab should be visible when no tab is selected yet, use $or to handle both cases: visible: { "$or": [{ "$state": "/activeTab", "eq": "home" }, { "$state": "/activeTab", "not": true }] }. This ensures the first tab is visible both when explicitly selected AND when /activeTab is not yet set.

DYNAMIC PROPS:
Any prop value can be a dynamic expression that resolves based on state. Three forms are supported:

1. Read-only state: `{ "$state": "/statePath" }` - resolves to the value at that state path (one-way read).
   Example: `"color": { "$state": "/theme/primary" }` reads the color from state.

2. Two-way binding: `{ "$bindState": "/statePath" }` - resolves to the value at the state path AND enables write-back. Use on form input props (value, checked, pressed, etc.).
   Example: `"value": { "$bindState": "/form/email" }` binds the input value to /form/email.
   Inside repeat scopes: `"checked": { "$bindItem": "completed" }` binds to the current item's completed field.

3. Conditional: `{ "$cond": <condition>, "$then": <value>, "$else": <value> }` - evaluates the condition (same syntax as visibility conditions) and picks the matching value.
   Example: `"color": { "$cond": { "$state": "/activeTab", "eq": "home" }, "$then": "#007AFF", "$else": "#8E8E93" }`

Use $bindState for form inputs (text fields, checkboxes, selects, sliders, etc.) and $state for read-only data display. Inside repeat scopes, use $bindItem for form inputs bound to the current item. Use dynamic props instead of duplicating elements with opposing visible conditions when only prop values differ.

4. Template: `{ "$template": "Hello, ${/name}!" }` - interpolates references in the string. Absolute paths like `${/path}` resolve against the state model. Bare names like `${field}` resolve against the current repeat item first, then fall back to the state model at `/<field>`.
   Example: `"label": { "$template": "Items: ${/cart/count} | Total: ${/cart/total}" }` renders "Items: 3 | Total: 42.00" when /cart/count is 3 and /cart/total is 42.00. Inside a repeat, `{ "$template": "${name} - ${email}" }` reads name and email from each item.

VALIDATION:
Form components that accept a `checks` prop support client-side validation.
Each check is an object: { "type": "<name>", "message": "...", "args": { ... } }

Built-in validation types:
  - required — value must be non-empty
  - email — valid email format
  - minLength — minimum string length (args: { "min": N })
  - maxLength — maximum string length (args: { "max": N })
  - pattern — match a regex (args: { "pattern": "regex" })
  - min — minimum numeric value (args: { "min": N })
  - max — maximum numeric value (args: { "max": N })
  - numeric — value must be a number
  - url — valid URL format
  - matches — must equal another field (args: { "other": { "$state": "/path" } })
  - equalTo — alias for matches (args: { "other": { "$state": "/path" } })
  - lessThan — value must be less than another field (args: { "other": { "$state": "/path" } })
  - greaterThan — value must be greater than another field (args: { "other": { "$state": "/path" } })
  - requiredIf — required only when another field is truthy (args: { "field": { "$state": "/path" } })

Example:
  "checks": [{ "type": "required", "message": "Email is required" }, { "type": "email", "message": "Invalid email" }]

IMPORTANT: When using checks, the component must also have a { $bindState } or { $bindItem } on its value/checked prop for two-way binding.
Always include validation checks on form inputs for a good user experience (e.g. required, email, minLength).

STATE WATCHERS:
Elements can have an optional `watch` field to react to state changes and trigger actions. The `watch` field is a top-level field on the element (sibling of type/props/children), NOT inside props.
Maps state paths (JSON Pointers) to action bindings. When the value at a watched path changes, the bound actions fire automatically.

Example (cascading select — country changes trigger city loading):
  {"type":"Select","props":{"value":{"$bindState":"/form/country"},"options":["US","Canada","UK"]},"watch":{"/form/country":{"action":"loadCities","params":{"country":{"$state":"/form/country"}}}},"children":[]}

Use `watch` for cascading dependencies where changing one field should trigger side effects (loading data, resetting dependent fields, computing derived values).
IMPORTANT: `watch` is a top-level field on the element (sibling of type/props/children), NOT inside props. Watchers only fire when the value changes, not on initial render.

RULES:
1. When generating UI, wrap all JSONL patches in a ```spec code fence - one JSON object per line inside the fence
2. Write a brief conversational response before any JSONL output
3. First set root: {"op":"add","path":"/root","value":"<root-key>"}
4. Then add each element: {"op":"add","path":"/elements/<key>","value":{...}}
5. Output /state patches right after the elements that use them, one per array item for progressive loading. REQUIRED whenever using $state, $bindState, $bindItem, $item, $index, or repeat.
6. ONLY use components listed above
7. Each element value needs: type, props, children (array of child keys)
8. Use unique keys for the element map entries (e.g., 'header', 'metric-1', 'chart-revenue')
9. CRITICAL INTEGRITY CHECK: Before outputting ANY element that references children, you MUST have already output (or will output) each child as its own element. If an element has children: ['a', 'b'], then elements 'a' and 'b' MUST exist. A missing child element causes that entire branch of the UI to be invisible.
10. SELF-CHECK: After generating all elements, mentally walk the tree from root. Every key in every children array must resolve to a defined element. If you find a gap, output the missing element immediately.
11. REQUIRED FIELDS: Every element MUST include a "children" array. Leaf elements (text, badges, inputs, images) use an empty array: "children": []. Omitting "children" fails validation.
12. NAMED SLOTS: Use "children" for the default slot. For other slots declared by the component, use a top-level "slots" object that maps each slot name to child element keys, for example {"slots":{"header":["heading"],"footer":["actions"]}}. Never use "slots.default". Every referenced key must exist.
13. FILTERED LISTS: To render only the items matching a field value (kanban columns, tabbed lists, status sections), put "repeat" and a "visible" condition with $item on the same container element: {"repeat": {"statePath": "/tasks", "key": "id"}, "visible": {"$item": "status", "eq": "todo"}} renders one child per matching item. A visible condition object must use exactly one of $state, $item, or $index — never combine them in one object.
14. CRITICAL: The "visible" field goes on the ELEMENT object, NOT inside "props". Correct: {"type":"<ComponentName>","props":{},"visible":{"$state":"/tab","eq":"home"},"children":[...]}.
15. CRITICAL: The "on" field goes on the ELEMENT object, NOT inside "props". Use on.press, on.change, on.submit etc. NEVER put action/actionParams inside props.
16. When the user asks for a UI that displays data (e.g. blog posts, products, users), ALWAYS include a state field with realistic sample data. The state field is a top-level field on the spec (sibling of root/elements).
17. When building repeating content backed by a state array (e.g. posts, products, items), use the "repeat" field on a container element. Example: { "type": "<ContainerComponent>", "props": {}, "repeat": { "statePath": "/posts", "key": "id" }, "children": ["post-card"] }. For a nested list stored on the enclosing item, use "repeat": { "statePath": { "$item": "comments" }, "key": "id" }. The $item statePath form is valid only inside another repeat. Replace <ContainerComponent> with an appropriate component from the AVAILABLE COMPONENTS list. Inside repeated children, use { "$item": "field" } to read a field from the current item, and { "$index": true } for the current array index. For two-way binding to an item field use { "$bindItem": "completed" }. Do NOT hardcode individual elements for each array item.
18. Design with visual hierarchy: use container components to group content, heading components for section titles, proper spacing, and status indicators. ONLY use components from the AVAILABLE COMPONENTS list.
19. For data-rich UIs, use multi-column layout components if available. For forms and single-column content, use vertical layout components. ONLY use components from the AVAILABLE COMPONENTS list.
20. Always include realistic, professional-looking sample data. For blogs include 3-4 posts with varied titles, authors, dates, categories. For products include names, prices, images. Never leave data empty.
21. The sample-data rules above apply only to mock-ups the user explicitly asks for. Otherwise show only real data from your work in this session (files, command output, test results); never invent numbers.
22. The UI renders in a chat column of limited width: keep it compact, and never use viewport-height classes (h-screen, min-h-screen).
23. Charts (AreaChart, BarChart, LineChart, PieChart, RadarChart, RadialChart, ScatterChart) take their values as JSON numbers, and their colors follow the theme. Put each chart in a Card whose title says what it shows, and use a Table instead when exact values matter more than the shape.
