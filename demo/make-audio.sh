#!/bin/bash
# Regenerates the demo audio with macOS text-to-speech (needs `say` and ffmpeg). Voices: Rishi = doctor, Aman = patient, Tara = daughter.
set -e
cd "$(dirname "$0")/audio"
tmp=$(mktemp -d)
DOC="Rishi"; PAT="Aman (English (India))"; FAM="Tara (English (India))"

# --- consultation: [voice|line]. The telmisartan line deliberately disagrees with the printed prescription (1-0-1).
lines=(
"$DOC|Good morning, Mr. Venkat. How have you been since coming home from the hospital?"
"$PAT|Better, doctor. The swelling in my legs has gone down. I weigh myself every morning."
"$FAM|Doctor, he still takes the old aspirin sometimes, along with the new blood thinner."
"$DOC|Please stop the aspirin completely. Only clopidogrel, seventy-five milligram, once a day."
"$DOC|Furosemide stays at forty milligram every morning for two weeks. After that we bring it down to twenty milligram."
"$DOC|Telmisartan. The prescription says twice a day, but because of the kidney numbers, I want him on it only in the morning for now. Forty milligram, morning only."
"$DOC|Continue amlodipine, glimepiride, atorvastatin and pantoprazole as before."
"$DOC|Please check blood pressure and weight every morning, and sugar before breakfast. Call me if the weight goes up by more than one and a half kilos."
"$FAM|Doctor, can he fast on Ekadashi next week?"
"$DOC|No fasting for now, with the sugar tablet and the water tablet. Small meals and low salt are fine."
"$FAM|And how much water can he drink in a day?"
"$DOC|One litre in a day, everything included. Tea, curd rice, soups, all of it."
"$DOC|Please get the kidney test done after two weeks, and see me again in four weeks."
)
i=0; : > "$tmp/list.txt"
for l in "${lines[@]}"; do
  v="${l%%|*}"; t="${l#*|}"; f="$tmp/c$(printf %02d $i).aiff"
  say -v "$v" -r 165 -o "$f" "$t"; echo "file '$f'" >> "$tmp/list.txt"
  ffmpeg -loglevel error -y -f lavfi -i anullsrc=r=22050:cl=mono -t 0.5 "$tmp/s$i.aiff"; echo "file '$tmp/s$i.aiff'" >> "$tmp/list.txt"
  i=$((i+1))
done
ffmpeg -loglevel error -y -f concat -safe 0 -i "$tmp/list.txt" -ar 22050 -ac 1 -c:a aac -b:a 64k consultation.m4a

# --- the doctor's dictation
say -v "$DOC" -r 170 -o "$tmp/d.aiff" "Seventy one year old male. Heart failure with reduced ejection fraction, type two diabetes, C K D stage three B. Post discharge review. Pedal oedema resolved. Weight seventy one point five kilos, blood pressure one forty two over eighty eight. Furosemide forty milligram for fourteen days, then twenty. Stop aspirin. Continue clopidogrel. Repeat creatinine and potassium in two weeks."
ffmpeg -loglevel error -y -i "$tmp/d.aiff" -ar 22050 -ac 1 -c:a aac -b:a 64k dictation-clinical-note.m4a

# --- the patient's voice notes
say -v "$PAT" -r 160 -o "$tmp/v1.aiff" "Weight is seventy two point eight kilos. B P one thirty two over eighty four. Sugar one ten. Took all tablets."
say -v "$PAT" -r 150 -o "$tmp/v2.aiff" "Doctor madam, my ankles are a little swollen this evening, and I feel slightly breathless when I climb the stairs."
say -v "$PAT" -r 160 -o "$tmp/v3.aiff" "Taken the morning tablets except the water tablet. I forgot it."
for n in 1 2 3; do ffmpeg -loglevel error -y -i "$tmp/v$n.aiff" -ar 22050 -ac 1 -c:a aac -b:a 64k "patient-voice-note-$n.m4a"; done
rm -rf "$tmp"; ls -la
