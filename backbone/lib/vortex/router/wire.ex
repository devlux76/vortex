defmodule Vortex.Router.Wire do
  @moduledoc """
  The messages between an owner's service and the router: one JSON object
  per line. Ring messages carry only names, counts, cursors and identifiers.
  Authenticated local embedding requests also carry already-prefixed topic or
  message text, which is never logged or persisted by the router.

  From the service:

      {"t":"hello","v":1,"owner":NAME,"token":TOKEN,"quiet_ms":N}   quiet_ms optional
      {"t":"state","waiters":N,"running":RING|null,"rooms":[{"room":KEY,"unread":N,"oldest":CURSOR}]}
      {"t":"embed","id":ID,"text":TEXT}
      {"t":"acted"}
      {"t":"started","ring":RING}
      {"t":"refused","ring":RING}
      {"t":"exited","ring":RING,"code":0..255}

  To the service:

      {"t":"embedded","id":ID,"vector":[768 floats]}
      {"t":"embed_error","id":ID,"reason":REASON}
      {"t":"welcome"}
      {"t":"error","reason":REASON}
      {"t":"ring","ring":RING,"room":KEY,"unread":N}

  Unknown fields are ignored. A line that is not one of the messages above
  decodes to `:error`.
  """

  @type event ::
          {:hello, String.t(), String.t(), non_neg_integer() | nil}
          | {:state, %{waiters: non_neg_integer(), running: String.t() | nil, rooms: [map()]}}
          | {:embed, String.t(), String.t()}
          | :acted
          | {:started, String.t()}
          | {:refused, String.t()}
          | {:exited, String.t(), 0..255}

  @spec decode(String.t()) :: {:ok, event()} | :error
  def decode(line) do
    with {:ok, %{"t" => type} = message} <- JSON.decode(line), {:ok, _} = ok <- event(type, message) do
      ok
    else
      _ -> :error
    end
  end

  @spec encode({:ring, String.t(), String.t(), pos_integer()} | :welcome | {:error, atom()} |
    {:embedded, String.t(), [number()]} | {:embed_error, String.t(), atom()}) :: String.t()
  def encode({:ring, ring, room, unread}), do: JSON.encode!(%{t: "ring", ring: ring, room: room, unread: unread})
  def encode({:embedded, id, vector}), do: JSON.encode!(%{t: "embedded", id: id, vector: vector})
  def encode({:embed_error, id, reason}), do: JSON.encode!(%{t: "embed_error", id: id, reason: reason})
  def encode(:welcome), do: JSON.encode!(%{t: "welcome"})
  def encode({:error, reason}), do: JSON.encode!(%{t: "error", reason: reason})

  defp event("hello", %{"v" => 1, "owner" => owner, "token" => token} = message) when is_binary(owner) and is_binary(token) do
    quiet_ms = Map.get(message, "quiet_ms")

    if owner =~ ~r/\A[a-z0-9_-]{1,32}\z/ and byte_size(token) in 16..128 and (quiet_ms == nil or count?(quiet_ms)),
      do: {:ok, {:hello, owner, token, quiet_ms}},
      else: :error
  end

  defp event("state", %{"waiters" => waiters, "rooms" => rooms} = message) when is_list(rooms) do
    running = Map.get(message, "running")

    with true <- count?(waiters) and (running == nil or id?(running, 64)),
         {:ok, rooms} <- rooms(rooms) do
      {:ok, {:state, %{waiters: waiters, running: running, rooms: rooms}}}
    else
      _ -> :error
    end
  end

  defp event("embed", %{"id" => id, "text" => text}) when is_binary(text) do
    if id?(id, 128) and byte_size(text) in 1..65_536,
      do: {:ok, {:embed, id, text}}, else: :error
  end

  defp event("acted", _message), do: {:ok, :acted}

  defp event(reply, %{"ring" => ring}) when reply in ["started", "refused"] do
    if id?(ring, 64), do: {:ok, {String.to_existing_atom(reply), ring}}, else: :error
  end

  defp event("exited", %{"ring" => ring, "code" => code}) when is_integer(code) and code in 0..255 do
    if id?(ring, 64), do: {:ok, {:exited, ring, code}}, else: :error
  end

  defp event(_type, _message), do: :error

  defp rooms(rooms) do
    Enum.reduce_while(rooms, {:ok, []}, fn
      %{"room" => room, "unread" => unread, "oldest" => oldest}, {:ok, acc} ->
        if id?(room, 128) and count?(unread) and unread > 0 and count?(oldest),
          do: {:cont, {:ok, acc ++ [%{room: room, unread: unread, oldest: oldest}]}},
          else: {:halt, :error}

      _, _ ->
        {:halt, :error}
    end)
  end

  # Counts and cursors stay within what a JavaScript number holds exactly.
  defp count?(value), do: is_integer(value) and value in 0..9_007_199_254_740_991
  defp id?(value, max), do: is_binary(value) and byte_size(value) in 1..max
end
