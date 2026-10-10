import { getShellTransport } from "@/lib/transport"
import type {
  RemoteWorkspaceConnection,
  RemoteWorkspaceConnectionInput,
} from "@/lib/types"

export async function listRemoteWorkspaceConnections(): Promise<
  RemoteWorkspaceConnection[]
> {
  return getShellTransport().call("list_remote_workspace_connections")
}

export async function getRemoteWorkspaceConnection(
  id: number
): Promise<RemoteWorkspaceConnection> {
  return getShellTransport().call("get_remote_workspace_connection", { id })
}

export async function testRemoteWorkspaceConnection(
  input: RemoteWorkspaceConnectionInput
): Promise<void> {
  return getShellTransport().call("test_remote_workspace_connection", { input })
}

export async function createRemoteWorkspaceConnection(
  input: RemoteWorkspaceConnectionInput
): Promise<RemoteWorkspaceConnection> {
  return getShellTransport().call("create_remote_workspace_connection", {
    input,
  })
}

export async function updateRemoteWorkspaceConnection(
  id: number,
  input: RemoteWorkspaceConnectionInput
): Promise<RemoteWorkspaceConnection> {
  return getShellTransport().call("update_remote_workspace_connection", {
    id,
    input,
  })
}

export async function deleteRemoteWorkspaceConnection(
  id: number
): Promise<void> {
  return getShellTransport().call("delete_remote_workspace_connection", { id })
}

export async function reorderRemoteWorkspaceConnections(
  ids: number[]
): Promise<void> {
  return getShellTransport().call("reorder_remote_workspace_connections", {
    ids,
  })
}

export async function openRemoteWorkspace(id: number): Promise<void> {
  return getShellTransport().call("open_remote_workspace", { id })
}

export async function openLocalWorkspace(): Promise<void> {
  return getShellTransport().call("open_local_workspace")
}
