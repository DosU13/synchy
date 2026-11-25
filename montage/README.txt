The montage that plays when nobody is using the booth.

clips\        short clips cut from the trailers in the "trailers" folder (do not edit by hand)
clips.json    the list of clips and which film each one belongs to
hidden.txt    clips hidden with the X key; delete a line to bring that clip back

To add a film: put its trailer (.mp4) in the "trailers" folder. The file name must contain
the film's title or one of its other names from films.json, e.g. "Мерген трейлер.mp4" or
"MERGEN trailer.mp4". The booth cuts new trailers into clips by itself when it starts.
To do it without the booth, double-click build-montage.bat. Both need ffmpeg.

Each round shows one clip from every film, in a random order, with crossfades, and the
film's title in the bottom-left corner. The clips are silent.

You can also put your own videos (.mp4) straight into this folder. They play in the
montage too, without a title. After adding videos, press R on the booth screen.
