/** What a model reads about `show_gallery`. */
export function showGalleryInstructions(): string {
  return (
    'Show SEVERAL images together as a gallery this app draws for the user — a scrolling strip of cards that ' +
    'opens full-screen, where they can zoom and step between the pictures. ' +
    'Use it when you have produced or found more than one picture that belongs together: screenshots ' +
    'before and after a change, the frames of a flow, several charts some other tool wrote to disk. ' +
    'Do NOT use it for ONE picture — a single markdown image (`![caption](/path/to.png)`) already renders ' +
    'in this transcript and reads better inline; this tool is for a SET, and its value is that the user ' +
    'can step between them. ' +
    'It is also not for numbers you have measured: use show_chart or show_metrics for those, which draw ' +
    'the data itself rather than a picture of it. ' +
    'Name each image by its FULL path on disk — always, even for a file right beside you. A relative path ' +
    "is measured against this conversation's own working directory, which is frequently not the one you " +
    'wrote the file in, and the tile then fails to load. A picture on the web can be named by its http(s) ' +
    'URL instead: this app downloads it when you call the tool, so do not download it yourself first. ' +
    'Do not paste image data; this app reads the files. ' +
    'When a picture needs words, give it a short caption, and a description when the reader needs the ' +
    'details too (contents, price, what changed); both show under the picture. ' +
    'Call it ONCE per set, and do not also list the paths as text: the user sees the pictures, so writing ' +
    'the filenames out again shows the same thing twice. Say what the images SHOW in your reply. ' +
    'The result is a short receipt counting what was shown, never the paths themselves; it names any URL ' +
    'that could not be downloaded.'
  );
}
