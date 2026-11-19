/**
 * Files an operating system drops into any folder a person has looked at: Finder's
 * .DS_Store and "._name" companions, Explorer's Thumbs.db and desktop.ini. They are
 * not part of a backup or of the local runtime's data, and Hearthside never wrote
 * them, so the places that refuse anything they don't recognise step over these
 * instead. They are ignored, never deleted: they aren't ours to remove.
 *
 * Deliberately short. A sync tool's conflict copy, or any other stray file, is still
 * refused where it was refused before: it might be a real piece under another name.
 */
export function isOsJunkFile(name: string): boolean {
  return name === ".DS_Store" || name === "Thumbs.db" || name === "desktop.ini" || name.startsWith("._");
}
