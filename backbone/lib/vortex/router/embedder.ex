defmodule Vortex.Router.Embedder do
  @moduledoc """
  Bounded access to the shared local embedding pool. Text is already prefixed
  by the service; it is sent verbatim, never logged or retained by the router.
  """
  use GenServer

  @urls ["http://127.0.0.1:8096/v1/embeddings", "http://127.0.0.1:8091/v1/embeddings",
         "http://127.0.0.1:8097/v1/embeddings"]

  def start_link(opts), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  def request(reply_to, id, text), do: GenServer.cast(__MODULE__, {:embed, reply_to, id, text})

  @impl true
  def init(opts), do: {:ok, %{urls: Keyword.get(opts, :embed_urls, @urls), pending: %{}}}

  @impl true
  def handle_cast({:embed, reply_to, id, text}, state) do
    if map_size(state.pending) >= 2 do
      send(reply_to, {:out, {:embed_error, id, :busy}})
      {:noreply, state}
    else
      urls = state.urls
      task = Task.Supervisor.async_nolink(Vortex.Router.EmbeddingTasks, fn -> embed(urls, text) end)
      {:noreply, %{state | pending: Map.put(state.pending, task.ref, {reply_to, id})}}
    end
  end

  @impl true
  def handle_info({ref, result}, state) when is_reference(ref) do
    Process.demonitor(ref, [:flush])
    finish(ref, result, state)
  end

  def handle_info({:DOWN, ref, :process, _pid, _reason}, state), do: finish(ref, {:error, :unavailable}, state)

  defp finish(ref, result, state) do
    case Map.pop(state.pending, ref) do
      {nil, _} -> {:noreply, state}
      {{reply_to, id}, pending} ->
        reply = case result do
          {:ok, vector} -> {:embedded, id, vector}
          {:error, reason} -> {:embed_error, id, reason}
        end
        send(reply_to, {:out, reply})
        {:noreply, %{state | pending: pending}}
    end
  end

  defp embed(urls, text) do
    Enum.reduce_while(urls, {:error, :unavailable}, fn url, _ ->
      case request_http(url, text) do
        {:ok, _} = ok -> {:halt, ok}
        _ -> {:cont, {:error, :unavailable}}
      end
    end)
  end

  defp request_http(url, text) do
    body = JSON.encode!(%{input: text, encoding_format: "float"})
    with {:ok, {{_, 200, _}, _, response}} <-
           :httpc.request(:post, {String.to_charlist(url), [], ~c"application/json", body},
             [ssl: [], connect_timeout: 1_000, timeout: 5_000], [body_format: :binary]),
         {:ok, %{"data" => [%{"embedding" => vector} | _]}} <- JSON.decode(response),
         true <- is_list(vector) and length(vector) == 768 and Enum.all?(vector, &is_number/1) do
      {:ok, vector}
    else
      _ -> {:error, :unavailable}
    end
  rescue
    _ -> {:error, :unavailable}
  catch
    _, _ -> {:error, :unavailable}
  end
end
