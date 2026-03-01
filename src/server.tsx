import { renderToReadableStream } from "react-dom/server";
import { App } from "./app";

export async function render(url: string): Promise<ReadableStream> {
	return renderToReadableStream(<App url={url} />);
}
