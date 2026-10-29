# GitLab work-item children

Use this procedure when an existing issue must appear as a native child item, rather than
only linking to its parent in prose. Verified with glab 1.114.0 and this instance's GitLab
19.5.1 on 2026-10-29: parent #283 has Task children #284-#317, retaining their original ids,
descriptions, labels and dependency lists.

Hierarchy and blocking are separate features. This instance permits Task children under an
Issue even though native blocking links return a license error. Keep explicit `Blocked by`
references for dependencies while using native hierarchy for parentage.

## Attach existing items

1. Read the parent and children through the issue REST API. Preserve their ids, descriptions,
   labels, state and other assigned metadata. The REST `id` is the database id; `iid` is the
   project-visible issue number. Construct work-item Global IDs from `id`, never `iid`.
2. Query the parent's hierarchy definition and the child's current parent/type. Use the Task
   type id returned by `allowedChildTypes`; refuse to move a child away from another parent
   unless that move was requested.
3. Convert an Issue to the permitted Task type with `workItemConvert`. This preserves its id
   and project-visible number. `workItemTypeUpdate` edits the type definition itself and is
   not the conversion operation.
4. Set the child's `hierarchyWidget.parentId` with `workItemUpdate`.
5. Read the parent's complete child list, handling pagination, and each child's parent. Verify
   every requested item appears once and all preserved metadata is unchanged.

The installed `glab work-items update` has no parent/type-conversion flag. Run the verified
GraphQL operations through `glab api`, passing a serialized JSON request to preserve variables
and quoting:

```bash
glab api --hostname gitlab.futo.org --method POST graphql \
  --header 'Content-Type: application/json' --input request.json
```

The request contains `query` and `variables`. Read the current work item with the top-level
`workItem(id: $id)` field, not `project.workItem`. Hierarchy fields are available through
`widgets { type ... on WorkItemWidgetHierarchy { parent { id iid } } }`.

Conversion query; supply the existing work-item id and permitted Task type id in `input`:

```graphql
mutation($input: WorkItemConvertInput!) {
  workItemConvert(input: $input) {
    errors
    workItem { id iid workItemType { name } }
  }
}
```

Its input fields are `id` and `workItemTypeId`.

Parent assignment query; supply the child id plus `hierarchyWidget: {parentId: parentGlobalId}`:

```graphql
mutation($input: WorkItemUpdateInput!) {
  workItemUpdate(input: $input) {
    errors
    workItem {
      id iid
      widgets {
        type
        ... on WorkItemWidgetHierarchy { parent { id iid } }
      }
    }
  }
}
```

Check both top-level GraphQL errors and mutation `errors`, even when HTTP succeeds. To verify
all children, query the parent's `WorkItemWidgetHierarchy.children(first: 100)` with
`nodes { id iid workItemType { name } }` and `pageInfo { hasNextPage endCursor }`.
