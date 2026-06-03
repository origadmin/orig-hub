package app

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"strconv"
)

func CreateTrayIcon() []byte {
	const size = 32
	img := image.NewRGBA(image.Rect(0, 0, size, size))

	bg := color.RGBA{78, 222, 163, 255}
	dark := color.RGBA{52, 211, 153, 255}

	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			dx := x - size/2
			dy := y - size/2
			dist := dx*dx + dy*dy
			r := (size / 2) * (size / 2)
			if dist <= r {
				if dy > 0 {
					img.Set(x, y, dark)
				} else {
					img.Set(x, y, bg)
				}
			}
		}
	}

	var buf bytes.Buffer
	png.Encode(&buf, img)
	return buf.Bytes()
}

func CreateTrayIconActive() []byte {
	const size = 32
	img := image.NewRGBA(image.Rect(0, 0, size, size))

	bg := color.RGBA{78, 222, 163, 255}
	glow := color.RGBA{52, 215, 246, 255}

	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			dx := x - size/2
			dy := y - size/2
			dist := dx*dx + dy*dy
			r := (size / 2) * (size / 2)
			if dist <= r {
				if dy > 0 {
					img.Set(x, y, glow)
				} else {
					img.Set(x, y, bg)
				}
			}
		}
	}

	var buf bytes.Buffer
	png.Encode(&buf, img)
	return buf.Bytes()
}

func formatFloatImpl(f float64, prec int) string {
	return strconv.FormatFloat(f, 'f', prec, 64)
}

func formatIntImpl(i int) string {
	return strconv.Itoa(i)
}
